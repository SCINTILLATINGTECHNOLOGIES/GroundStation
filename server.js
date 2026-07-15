const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const db = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "groundstation", timestamp: Date.now() });
});

// Load initial data from database
let drones = {};
let droneSockets = {};

function loadInitialData() {
  db.getAllDrones((err, rows) => {
    if (err) {
      console.error('Failed to load drones from database:', err);
      return;
    }

    rows.forEach(row => {
      drones[row.id] = {
        ...row,
        lastSeen: row.lastSeen || row.updated_at || Date.now()
      };
    });

    console.log(`Loaded ${Object.keys(drones).length} drones from database`);
  });
}

loadInitialData();

function broadcastFleet() {
  io.emit("fleetUpdate", { drones, count: Object.keys(drones).length });
}

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.emit("init", { drones, count: Object.keys(drones).length });

  socket.on("registerDrone", (data) => {
    if (!data || !data.id) return;

    droneSockets[data.id] = socket.id;
    drones[data.id] = {
      ...drones[data.id],
      ...data,
      lastSeen: Date.now(),
      status: data.status || "idle"
    };

    // Save to database
    db.saveDrone(drones[data.id], (err) => {
      if (err) {
        console.error('Failed to save drone to database:', err);
      }
    });

    console.log(`Drone registered: ${data.id}`);
    io.emit("droneUpdate", drones[data.id]);
    broadcastFleet();
  });

  socket.on("updateDrone", (data) => {
    if (!data || !data.id) return;

    drones[data.id] = {
      ...drones[data.id],
      ...data,
      lastSeen: Date.now()
    };

    // Save to database
    db.saveDrone(drones[data.id], (err) => {
      if (err) {
        console.error('Failed to save drone telemetry to database:', err);
      }
    });

    console.log(`Telemetry update from ${data.id}`);
    io.emit("droneUpdate", drones[data.id]);
    broadcastFleet();
  });

  socket.on("command", (cmd) => {
    console.log("Command received:", cmd);

    if (cmd && cmd.target && droneSockets[cmd.target]) {
      io.to(droneSockets[cmd.target]).emit("command", cmd);
      console.log(`Sent targeted command to ${cmd.target}`);
      return;
    }

    io.emit("command", cmd);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);

    const droneId = Object.keys(droneSockets).find((id) => droneSockets[id] === socket.id);
    if (droneId) {
      console.log(`Drone disconnected: ${droneId}`);
      delete droneSockets[droneId];
      if (drones[droneId]) {
        drones[droneId].status = "offline";
        drones[droneId].lastSeen = Date.now();
      }
      broadcastFleet();
    }
  });
});

app.get("/api/drones", (req, res) => {
  res.json({ drones, count: Object.keys(drones).length });
});

app.get("/api/drones/:id", (req, res) => {
  const drone = drones[req.params.id];
  if (!drone) {
    return res.status(404).json({ error: "Drone not found" });
  }
  res.json(drone);
});

app.post("/api/command", (req, res) => {
  const cmd = req.body;
  if (!cmd || !cmd.action) {
    return res.status(400).json({ error: "Command payload required" });
  }

  if (cmd.target && droneSockets[cmd.target]) {
    io.to(droneSockets[cmd.target]).emit("command", cmd);
  } else {
    io.emit("command", cmd);
  }

  res.json({ ok: true, sentTo: cmd.target || "broadcast" });
});

app.post("/api/drone/:id/telemetry", (req, res) => {
  const id = req.params.id;
  const payload = req.body;
  if (!payload) {
    return res.status(400).json({ error: "Telemetry payload required" });
  }

  drones[id] = {
    ...drones[id],
    ...payload,
    id,
    lastSeen: Date.now()
  };

  // Save to database
  db.saveDrone(drones[id], (err) => {
    if (err) {
      console.error('Failed to save telemetry to database:', err);
      return res.status(500).json({ error: "Database error" });
    }

    io.emit("droneUpdate", drones[id]);
    broadcastFleet();
    res.json({ ok: true, drone: drones[id] });
  });
});

// Package API endpoints
app.get("/api/packages", (req, res) => {
  const packages = db.getAllPackages();
  res.json({ packages, count: packages.length });
});

app.get("/api/packages/queued", (req, res) => {
  const packages = db.getQueuedPackages();
  res.json({ packages, count: packages.length });
});

app.get("/api/packages/:id", (req, res) => {
  const pkg = db.getPackageById(req.params.id);
  if (!pkg) {
    return res.status(404).json({ error: "Package not found" });
  }
  res.json(pkg);
});

app.post("/api/packages", (req, res) => {
  const packageData = req.body;
  if (!packageData.id || !packageData.latitude || !packageData.longitude) {
    return res.status(400).json({ error: "Package ID, latitude, and longitude required" });
  }

  try {
    const packageRecord = {
      ...packageData,
      status: packageData.status || 'queued',
      created_at: packageData.created_at || Date.now()
    };

    db.savePackage(packageRecord);
    db.logEvent(`Package created: ${packageRecord.id} for ${packageRecord.customer}`, 'package', null, packageRecord.id);
    io.emit("packageUpdate", packageRecord);
    res.json({ ok: true, package: packageRecord });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/packages/:id", (req, res) => {
  const id = req.params.id;
  const updates = req.body;

  try {
    const existing = db.getPackageById(id);
    if (!existing) {
      return res.status(404).json({ error: "Package not found" });
    }

    const updatedPackage = { ...existing, ...updates, id };
    db.savePackage(updatedPackage);

    if (updates.status) {
      db.logEvent(`Package ${id} status changed to ${updates.status}`, 'package', updates.assignedDrone, id);
    }

    io.emit("packageUpdate", updatedPackage);
    res.json({ ok: true, package: updatedPackage });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mission API endpoints
app.post("/api/missions", (req, res) => {
  const missionData = req.body;
  if (!missionData.id || !missionData.droneId || !missionData.waypoints) {
    return res.status(400).json({ error: "Mission ID, drone ID, and waypoints required" });
  }

  try {
    const mission = {
      ...missionData,
      status: missionData.status || 'planned',
      created_at: Date.now()
    };

    db.saveMission(mission);
    db.logEvent(`Mission created for drone ${missionData.droneId}`, 'mission', missionData.droneId);
    io.emit("missionUpdate", mission);
    res.json({ ok: true, mission });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/missions", (req, res) => {
  const missions = db.getAllMissions();
  res.json({ missions, count: missions.length });
});

app.get("/api/missions/:id", (req, res) => {
  const mission = db.getMissionById(req.params.id);
  if (!mission) {
    return res.status(404).json({ error: "Mission not found" });
  }
  res.json(mission);
});

// Logs API endpoints
app.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = db.getRecentLogs(limit);
  res.json({ logs, count: logs.length });
});

app.post("/api/logs", (req, res) => {
  const { message, type, droneId, packageId } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    db.logEvent(message, type, droneId, packageId);
    io.emit("logUpdate", { message, type, droneId, packageId, timestamp: Date.now() });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Alerts API endpoints
app.get("/api/alerts", (req, res) => {
  const alerts = db.getActiveAlerts();
  res.json({ alerts, count: alerts.length });
});

app.post("/api/alerts", (req, res) => {
  const { message, type } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    db.addAlert(message, type);
    io.emit("alertUpdate", { message, type, timestamp: Date.now() });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/alerts/:id/acknowledge", (req, res) => {
  const id = parseInt(req.params.id);
  try {
    db.acknowledgeAlert(id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Settings API endpoints
app.get("/api/settings", (req, res) => {
  const settings = db.getSettings();
  res.json(settings);
});

app.get("/api/settings/:key", (req, res) => {
  const key = req.params.key;
  const settings = db.getSettings();
  if (!(key in settings)) {
    return res.status(404).json({ error: "Setting not found" });
  }
  res.json({ key, value: settings[key] });
});

app.put("/api/settings/:key", (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  try {
    db.setSetting(key, value);
    io.emit("settingsUpdate", { key, value });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Ground Station server running on http://${HOST}:${PORT}`);
});