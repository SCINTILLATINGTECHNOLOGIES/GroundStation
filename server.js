const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const db = require("./database");
const fs = require("fs");

let geofence = { zones: [], obstacles: [] };
try {
  const gfRaw = fs.readFileSync(__dirname + "/nigeria_geofence.json", "utf8");
  geofence = JSON.parse(gfRaw);
  console.log(`Loaded geofence: ${geofence.zones.length} zones, ${geofence.obstacles.length} obstacles`);
} catch (e) {
  console.warn("Could not load geofence file:", e.message);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function pointInAnyZone(lat, lon) {
  const hits = [];
  if (!geofence) return { hits };
  (geofence.zones || []).forEach((z) => {
    const d = haversineMeters(lat, lon, z.lat, z.lon);
    if (d <= (z.radius_m || 0)) hits.push({ id: z.id, type: z.type, priority: z.priority, distance_m: d });
  });
  (geofence.obstacles || []).forEach((o) => {
    const d = haversineMeters(lat, lon, o.lat, o.lon);
    if (d <= (o.radius_m || 0)) hits.push({ id: o.id, type: o.type, priority: 'OBSTACLE', distance_m: d });
  });
  return { hits };
}

function validateGeofencePoint(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return { ok: false, error: 'Latitude and longitude must be numbers', hits: [] };
  }
  const result = pointInAnyZone(lat, lon);
  const hardHit = (result.hits || []).find(h => h.priority === 'HARD' || h.type === 'OBSTACLE');
  return {
    ok: !hardHit,
    hits: result.hits || [],
    error: hardHit ? `Location is inside a restricted geofence: ${hardHit.id}` : null
  };
}

function validateMissionWaypoints(waypoints) {
  if (!Array.isArray(waypoints)) return { ok: true, hits: [] };

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    if (!wp || typeof wp.latitude !== 'number' || typeof wp.longitude !== 'number') continue;
    const validation = validateGeofencePoint(wp.latitude, wp.longitude);
    if (!validation.ok) {
      return { ok: false, waypointIndex: i, hits: validation.hits, error: validation.error };
    }
  }

  return { ok: true, hits: [] };
}

function normalizeCommand(cmd) {
  if (!cmd || !cmd.action) return null;
  return {
    ...cmd,
    protocol: (cmd.protocol || cmd.transport || cmd.type || 'generic').toString().toLowerCase(),
    relayedAt: Date.now()
  };
}

const MAVLINK_MSG_ID_COMMAND_LONG = 76;
const MAV_CMD_COMPONENT_ARM_DISARM = 400;
const MAV_CMD_NAV_TAKEOFF = 22;
const MAV_CMD_NAV_LAND = 21;
const MAV_CMD_DO_SET_MODE = 176;
const MAV_CMD_NAV_WAYPOINT = 16;

function floatToLEBytes(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function uint16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function uint32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function mavlinkChecksum(payload) {
  let crc = 0xffff;
  for (const byte of payload) {
    crc = crc ^ byte;
    for (let i = 0; i < 8; i++) {
      const check = crc & 1;
      crc = (crc >> 1) & 0xffff;
      if (check) crc = crc ^ 0xa001;
    }
  }
  return crc & 0xffff;
}

function buildMavlinkCommandLong(cmd, targetSystem = 1, targetComponent = 1, sequence = 0) {
  const action = (cmd && cmd.action ? cmd.action : 'ARM').toString().toUpperCase();
  const params = Array.from({ length: 7 }, (_, index) => Number(cmd?.params?.[index] ?? cmd?.[`param${index + 1}`] ?? 0));

  const commandMap = {
    ARM: { command: MAV_CMD_COMPONENT_ARM_DISARM, param1: 1 },
    DISARM: { command: MAV_CMD_COMPONENT_ARM_DISARM, param1: 0 },
    TAKEOFF: { command: MAV_CMD_NAV_TAKEOFF, param1: 0 },
    LAND: { command: MAV_CMD_NAV_LAND, param1: 0 },
    RTL: { command: 20, param1: 0 },
    SET_MODE: { command: MAV_CMD_DO_SET_MODE, param1: Number(cmd.mode ?? 4) },
    WAYPOINT: { command: MAV_CMD_NAV_WAYPOINT, param1: 0, param5: Number(cmd.latitude ?? 0), param6: Number(cmd.longitude ?? 0), param7: Number(cmd.altitude ?? 0) },
    COMMAND_LONG: { command: Number(cmd.command ?? MAV_CMD_COMPONENT_ARM_DISARM) }
  };

  const mapped = commandMap[action] || commandMap.ARM;
  const commandId = Number(mapped.command ?? MAV_CMD_COMPONENT_ARM_DISARM);
  const payload = Buffer.alloc(33);
  payload[0] = Number(cmd.targetSystem ?? targetSystem);
  payload[1] = Number(cmd.targetComponent ?? targetComponent);
  uint16LE(commandId).copy(payload, 2);
  payload[4] = Number(cmd.confirmation ?? 0);

  const scalarSlots = [
    'param1', 'param2', 'param3', 'param4', 'param5', 'param6', 'param7'
  ];

  scalarSlots.forEach((key, index) => {
    const value = Number(mapped[key] ?? params[index] ?? cmd[key] ?? 0);
    floatToLEBytes(value).copy(payload, 5 + (index * 4));
  });

  const packet = Buffer.alloc(1 + 1 + 1 + 1 + 1 + 1 + 3 + payload.length + 2);
  packet[0] = 0xfd;
  packet[1] = payload.length;
  packet[2] = 0x00;
  packet[3] = 0x00;
  packet[4] = Number(sequence & 0xff);
  packet[5] = Number(cmd.systemId ?? 1);
  packet[6] = Number(cmd.componentId ?? 1);
  packet.writeUIntLE(MAVLINK_MSG_ID_COMMAND_LONG, 7, 3);
  payload.copy(packet, 10);

  const checksum = mavlinkChecksum(packet.slice(1, packet.length - 2));
  packet[packet.length - 2] = checksum & 0xff;
  packet[packet.length - 1] = (checksum >> 8) & 0xff;

  return {
    packetType: 'COMMAND_LONG',
    messageId: MAVLINK_MSG_ID_COMMAND_LONG,
    command: commandId,
    targetSystem: payload[0],
    targetComponent: payload[1],
    action,
    params: {
      param1: Number(payload.readFloatLE(5)),
      param2: Number(payload.readFloatLE(9)),
      param3: Number(payload.readFloatLE(13)),
      param4: Number(payload.readFloatLE(17)),
      param5: Number(payload.readFloatLE(21)),
      param6: Number(payload.readFloatLE(25)),
      param7: Number(payload.readFloatLE(29))
    },
    raw: packet.toString('hex'),
    hex: packet.toString('hex')
  };
}

function relayCommand(cmd) {
  const payload = normalizeCommand(cmd);
  if (!payload) return { ok: false, error: 'Command payload required' };

  const target = payload.target;
  const emitName = payload.protocol === 'mavlink' ? 'mavlinkCommand' : 'command';

  if (payload.protocol === 'mavlink') {
    const mavlinkPacket = buildMavlinkCommandLong(payload, payload.targetSystem ?? 1, payload.targetComponent ?? 1, payload.sequence ?? 0);
    const message = {
      ...payload,
      protocol: 'mavlink',
      packet: mavlinkPacket,
      raw: mavlinkPacket.raw,
      action: payload.action,
      command: mavlinkPacket.command,
      targetSystem: mavlinkPacket.targetSystem,
      targetComponent: mavlinkPacket.targetComponent
    };

    if (target && droneSockets[target]) {
      io.to(droneSockets[target]).emit(emitName, message);
      io.to(droneSockets[target]).emit('command', message);
      return { ok: true, sentTo: target, protocol: payload.protocol, packet: mavlinkPacket };
    }

    io.emit(emitName, message);
    io.emit('command', message);
    return { ok: true, sentTo: 'broadcast', protocol: payload.protocol, packet: mavlinkPacket };
  }

  if (target && droneSockets[target]) {
    io.to(droneSockets[target]).emit(emitName, payload);
    io.to(droneSockets[target]).emit('command', payload);
    return { ok: true, sentTo: target, protocol: payload.protocol };
  }

  io.emit(emitName, payload);
  io.emit('command', payload);
  return { ok: true, sentTo: 'broadcast', protocol: payload.protocol };
}

function parseHexPacket(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const clean = rawValue.trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!clean || clean.length % 2 !== 0) return null;

  try {
    return Buffer.from(clean, 'hex');
  } catch (error) {
    return null;
  }
}

function decodeMavlinkPacket(packetLike) {
  if (!packetLike) return null;

  let buffer = null;
  if (Buffer.isBuffer(packetLike)) buffer = packetLike;
  else if (typeof packetLike === 'string') buffer = parseHexPacket(packetLike) || Buffer.from(packetLike, 'utf8');
  else if (typeof packetLike === 'object') {
    if (typeof packetLike.hex === 'string') buffer = parseHexPacket(packetLike.hex);
    else if (typeof packetLike.raw === 'string') buffer = parseHexPacket(packetLike.raw);
    else if (Array.isArray(packetLike)) buffer = Buffer.from(packetLike);
  }

  if (!buffer || buffer.length < 10) return null;

  const messageId = buffer.readUIntLE(7, 3) || null;
  const packetType = messageId === 76 ? 'COMMAND_LONG' : 'RAW';
  return {
    version: 1,
    messageId,
    packetType,
    payloadLength: buffer[1],
    raw: buffer.toString('hex'),
    hex: buffer.toString('hex')
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

const weather = {
  condition: 'Clear',
  temperature_c: 24,
  wind_kph: 10,
  visibility_km: 12,
  updatedAt: Date.now()
};

// Real weather via OpenWeatherMap (free tier). Falls back to holding the
// last known values (does NOT fabricate data) if the API key is missing
// or a request fails - see project spec, Section 15.5.
const HOME_LAT = parseFloat(process.env.HOME_LAT || '9.08');
const HOME_LON = parseFloat(process.env.HOME_LON || '8.67');
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';

async function refreshWeather() {
  if (!OPENWEATHER_API_KEY) {
    console.warn('OPENWEATHER_API_KEY not set - weather will not update (holding last known values)');
    return;
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${HOME_LAT}&lon=${HOME_LON}&appid=${OPENWEATHER_API_KEY}&units=metric`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('Weather API request failed:', response.status, response.statusText);
      return;
    }

    const data = await response.json();
    weather.condition = data.weather?.[0]?.main || weather.condition;
    weather.temperature_c = Math.round(data.main?.temp ?? weather.temperature_c);
    weather.wind_kph = Math.round((data.wind?.speed ?? 0) * 3.6); // m/s -> km/h
    weather.visibility_km = Math.round((data.visibility ?? 10000) / 1000);
    weather.updatedAt = Date.now();
    io.emit('weatherUpdate', { ...weather });
  } catch (error) {
    console.error('Failed to fetch weather:', error.message);
  }
}

// Variant A max payload capacity (see project spec, Section 2 / 15.3)
// TODO: move to a config/settings value once multiple airframe variants exist
const MAX_PAYLOAD_KG = 1.0;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "groundstation", timestamp: Date.now() });
});

app.get("/api/weather", (req, res) => {
  res.json({ ...weather });
});

// Load initial data from database
let drones = {};
let packages = [];
let missions = [];
let logs = [];
let alerts = [];
let settings = {};
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

  db.getAllPackages((err, rows) => {
    if (!err) {
      packages = rows || [];
      console.log(`Loaded ${packages.length} packages from database`);
    }
  });

  db.getAllMissions((err, rows) => {
    if (!err) {
      missions = rows || [];
      console.log(`Loaded ${missions.length} missions from database`);
    }
  });

  db.getRecentLogs(100, (err, rows) => {
    if (!err) {
      logs = rows || [];
    }
  });

  db.getActiveAlerts((err, rows) => {
    if (!err) {
      alerts = rows || [];
    }
  });

  settings = db.getSettings();
}

loadInitialData();

function pushLog(message, type = 'info', droneId = null, packageId = null) {
  const entry = {
    id: Date.now(),
    timestamp: Date.now(),
    message,
    type,
    drone_id: droneId,
    package_id: packageId
  };

  logs.push(entry);
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  db.logEvent(message, type, droneId, packageId);
  io.emit('logUpdate', entry);
}

function broadcastState() {
  io.emit('stateUpdate', {
    drones,
    packages,
    missions,
    logs,
    alerts,
    settings,
    count: Object.keys(drones).length
  });
}

function broadcastFleet() {
  io.emit("fleetUpdate", { drones, count: Object.keys(drones).length });
}

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.emit("init", {
    drones,
    packages,
    missions,
    logs,
    alerts,
    settings,
    count: Object.keys(drones).length
  });

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
    const result = relayCommand(cmd);
    if (result.ok && result.sentTo !== 'broadcast') {
      console.log(`Sent ${result.protocol} command to ${result.sentTo}`);
    } else if (result.ok) {
      console.log(`Broadcast ${result.protocol} command`);
    }
  });

  socket.on("mavlinkCommand", (cmd) => {
    relayCommand({ ...cmd, protocol: 'mavlink' });
  });

  socket.on("mavlink", (packet) => {
    io.emit('mavlinkTelemetry', packet);
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

app.get("/api/state", (req, res) => {
  res.json({ drones, packages, missions, logs, alerts, settings, count: Object.keys(drones).length });
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
  const result = relayCommand(cmd);

  if (!result.ok) {
    return res.status(400).json({ error: result.error || 'Command payload required' });
  }

  res.json({ ok: true, sentTo: result.sentTo, protocol: result.protocol, packet: result.packet || null });
});

app.get("/api/mavlink/health", (req, res) => {
  res.json({ ok: true, service: 'mavlink-bridge', protocol: 'mavlink', timestamp: Date.now() });
});

app.post("/api/mavlink", (req, res) => {
  const payload = req.body || {};

  if (payload.action || payload.protocol === 'mavlink') {
    const result = relayCommand({ ...payload, protocol: 'mavlink' });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || 'MAVLink command rejected' });
    }

    return res.json({ ok: true, relayed: result, packet: result.packet || null });
  }

  const decoded = decodeMavlinkPacket(payload.raw || payload.hex || payload.packet || payload);
  if (!decoded) {
    return res.status(400).json({ ok: false, error: 'MAVLink packet payload required' });
  }

  io.emit('mavlinkTelemetry', decoded);
  return res.json({ ok: true, packet: decoded });
});

app.post("/api/mavlink/command", (req, res) => {
  const payload = req.body || {};
  const result = relayCommand({ ...payload, protocol: 'mavlink', action: payload.action || 'COMMAND_LONG' });

  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error || 'MAVLink command rejected' });
  }

  res.json({ ok: true, relayed: result, packet: result.packet || null });
});

app.post("/api/mavlink/telemetry", (req, res) => {
  const payload = req.body || {};
  const decoded = decodeMavlinkPacket(payload.raw || payload.hex || payload.packet || payload);

  if (!decoded) {
    return res.status(400).json({ ok: false, error: 'MAVLink telemetry packet required' });
  }

  io.emit('mavlinkTelemetry', decoded);
  res.json({ ok: true, packet: decoded });
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

  // Geofence validation
  const validation = validateGeofencePoint(packageData.latitude, packageData.longitude);
  if (!validation.ok) {
    pushLog(`Package ${packageData.id} rejected: ${validation.error}`, 'warning', null, packageData.id);
    return res.status(400).json({ error: "Delivery location is inside a restricted geofence", zones: validation.hits });
  }

  // Payload capacity validation (Variant A max: MAX_PAYLOAD_KG)
  const weight = Number(packageData.weight);
  const capacity_ok = Number.isFinite(weight) && weight > 0 && weight <= MAX_PAYLOAD_KG;
  if (!capacity_ok) {
    pushLog(`Package ${packageData.id} rejected: weight ${packageData.weight}kg exceeds max capacity ${MAX_PAYLOAD_KG}kg`, 'warning', null, packageData.id);
    return res.status(400).json({ error: `Payload weight exceeds max capacity of ${MAX_PAYLOAD_KG}kg`, weight: packageData.weight, max: MAX_PAYLOAD_KG });
  }

  try {
    const packageRecord = {
      ...packageData,
      status: packageData.status || 'queued',
      capacity_ok,
      created_at: packageData.created_at || Date.now()
    };

    db.savePackage(packageRecord);
    const existingIndex = packages.findIndex((item) => item.id === packageRecord.id);
    if (existingIndex >= 0) {
      packages[existingIndex] = packageRecord;
    } else {
      packages.push(packageRecord);
    }
    pushLog(`Package created: ${packageRecord.id} for ${packageRecord.customer}`, 'package', null, packageRecord.id);
    io.emit("packageUpdate", packageRecord);
    broadcastState();
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

    const lat = updates.latitude ?? existing.latitude;
    const lon = updates.longitude ?? existing.longitude;
    const validation = validateGeofencePoint(lat, lon);
    if (!validation.ok) {
      pushLog(`Package ${id} update rejected: ${validation.error}`, 'warning', updates.assignedDrone || null, id);
      return res.status(400).json({ error: "Delivery location is inside a restricted geofence", zones: validation.hits });
    }

    const updatedPackage = { ...existing, ...updates, id };
    db.savePackage(updatedPackage);
    const packageIndex = packages.findIndex((item) => item.id === id);
    if (packageIndex >= 0) {
      packages[packageIndex] = updatedPackage;
    } else {
      packages.push(updatedPackage);
    }

    if (updates.status) {
      pushLog(`Package ${id} status changed to ${updates.status}`, 'package', updates.assignedDrone, id);
    }

    io.emit("packageUpdate", updatedPackage);
    broadcastState();
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

  // Geofence validation for waypoints
  const waypointValidation = validateMissionWaypoints(missionData.waypoints);
  if (!waypointValidation.ok) {
    pushLog(`Mission ${missionData.id} rejected: waypoint ${waypointValidation.waypointIndex} is inside restricted geofence`, 'warning', missionData.droneId, null);
    return res.status(400).json({ error: `Waypoint ${waypointValidation.waypointIndex} is inside a restricted geofence`, zones: waypointValidation.hits });
  }

  try {
    const mission = {
      ...missionData,
      status: missionData.status || 'planned',
      created_at: Date.now()
    };

    db.saveMission(mission);
    const missionIndex = missions.findIndex((item) => item.id === mission.id);
    if (missionIndex >= 0) {
      missions[missionIndex] = mission;
    } else {
      missions.push(mission);
    }
    pushLog(`Mission created for drone ${missionData.droneId}`, 'mission', missionData.droneId, null);
    io.emit("missionUpdate", mission);
    broadcastState();
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

app.put("/api/missions/:id", (req, res) => {
  const id = req.params.id;
  const updates = req.body;

  try {
    const existing = missions.find((item) => item.id === id) || db.getMissionById(id);
    if (!existing) {
      return res.status(404).json({ error: "Mission not found" });
    }

    const candidateWaypoints = updates.waypoints || existing.waypoints || [];
    const waypointValidation = validateMissionWaypoints(candidateWaypoints);
    if (!waypointValidation.ok) {
      pushLog(`Mission ${id} update rejected: waypoint ${waypointValidation.waypointIndex} is inside restricted geofence`, 'warning', existing.droneId || null, null);
      return res.status(400).json({ error: `Waypoint ${waypointValidation.waypointIndex} is inside a restricted geofence`, zones: waypointValidation.hits });
    }

    const updatedMission = { ...existing, ...updates, id };
    db.saveMission(updatedMission);
    const missionIndex = missions.findIndex((item) => item.id === id);
    if (missionIndex >= 0) {
      missions[missionIndex] = updatedMission;
    } else {
      missions.push(updatedMission);
    }

    io.emit("missionUpdate", updatedMission);
    broadcastState();
    res.json({ ok: true, mission: updatedMission });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    logs.push({ message, type, droneId, packageId, timestamp: Date.now() });
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    io.emit("logUpdate", { message, type, droneId, packageId, timestamp: Date.now() });
    broadcastState();
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
    alerts.push({ id: Date.now(), message, type, timestamp: Date.now(), acknowledged: false });
    if (alerts.length > 500) alerts.splice(0, alerts.length - 500);
    io.emit("alertUpdate", { message, type, timestamp: Date.now() });
    broadcastState();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/alerts/:id/acknowledge", (req, res) => {
  const id = parseInt(req.params.id);
  try {
    db.acknowledgeAlert(id);
    const alert = alerts.find((item) => item.id === id);
    if (alert) alert.acknowledged = true;
    broadcastState();
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
    settings[key] = value;
    io.emit("settingsUpdate", { key, value });
    broadcastState();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Ground Station server running on http://${HOST}:${PORT}`);
  });
  setInterval(refreshWeather, 30000);
  refreshWeather();
}

module.exports = {
  app,
  server,
  io,
  haversineMeters,
  pointInAnyZone,
  validateGeofencePoint,
  validateMissionWaypoints,
  normalizeCommand,
  buildMavlinkCommandLong,
  relayCommand,
  parseHexPacket,
  decodeMavlinkPacket,
  getWeather: () => ({ ...weather }),
  refreshWeather
};