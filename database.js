const fs = require('fs');
const path = require('path');

// Data directory
const dataDir = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// File paths
const DRONES_FILE = path.join(dataDir, 'drones.json');
const PACKAGES_FILE = path.join(dataDir, 'packages.json');
const LOGS_FILE = path.join(dataDir, 'logs.json');
const ALERTS_FILE = path.join(dataDir, 'alerts.json');
const SETTINGS_FILE = path.join(dataDir, 'settings.json');
const MISSIONS_FILE = path.join(dataDir, 'missions.json');

// Helper functions for file operations
function readJsonFile(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn(`Failed to read ${filePath}:`, error.message);
  }
  return defaultValue;
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Failed to write ${filePath}:`, error.message);
  }
}

// Data management functions
function saveDrone(droneData, callback) {
  const drones = readJsonFile(DRONES_FILE, {});
  drones[droneData.id] = {
    ...drones[droneData.id],
    ...droneData,
    updated_at: Date.now()
  };
  writeJsonFile(DRONES_FILE, drones);
  if (callback) callback();
}

function savePackage(packageData, callback) {
  const packages = readJsonFile(PACKAGES_FILE, {});
  packages[packageData.id] = {
    ...packages[packageData.id],
    ...packageData,
    updated_at: Date.now()
  };
  writeJsonFile(PACKAGES_FILE, packages);
  if (callback) callback();
}

function logEvent(message, type = 'info', droneId = null, packageId = null, callback) {
  const logs = readJsonFile(LOGS_FILE, []);
  logs.push({
    id: Date.now(),
    timestamp: Date.now(),
    message,
    type,
    drone_id: droneId,
    package_id: packageId
  });

  // Keep only last 1000 logs
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000);
  }

  writeJsonFile(LOGS_FILE, logs);
  if (callback) callback();
}

function addAlert(message, type = 'info', callback) {
  const alerts = readJsonFile(ALERTS_FILE, []);
  alerts.push({
    id: Date.now(),
    timestamp: Date.now(),
    message,
    type,
    acknowledged: false
  });

  // Keep only last 500 alerts
  if (alerts.length > 500) {
    alerts.splice(0, alerts.length - 500);
  }

  writeJsonFile(ALERTS_FILE, alerts);
  if (callback) callback();
}

function getSettings(callback) {
  const settings = readJsonFile(SETTINGS_FILE, {});
  if (callback) callback(null, settings);
  return settings;
}

function getPackageById(id, callback) {
  const packages = readJsonFile(PACKAGES_FILE, {});
  const pkg = packages[id] || null;
  if (callback) callback(null, pkg);
  return pkg;
}

function saveMission(missionData, callback) {
  const missions = readJsonFile(MISSIONS_FILE, {});
  missions[missionData.id] = {
    ...missions[missionData.id],
    ...missionData,
    updated_at: Date.now()
  };
  writeJsonFile(MISSIONS_FILE, missions);
  if (callback) callback();
}

function getAllMissions(callback) {
  const missions = readJsonFile(MISSIONS_FILE, {});
  const missionArray = Object.values(missions);
  if (callback) callback(null, missionArray);
  return missionArray;
}

function getMissionById(id, callback) {
  const missions = readJsonFile(MISSIONS_FILE, {});
  const mission = missions[id] || null;
  if (callback) callback(null, mission);
  return mission;
}


function setSetting(key, value, callback) {
  const settings = readJsonFile(SETTINGS_FILE, {});
  settings[key] = value;
  writeJsonFile(SETTINGS_FILE, settings);
  if (callback) callback();
}

// Initialize default settings
function initializeDefaults(callback) {
  const defaults = {
    soundEnabled: true,
    autoUpdate: true,
    showTrails: true,
    darkMode: false,
    collisionThreshold: 100,
    batteryWarningLevel: 20,
    maxTrailLength: 50
  };

  const currentSettings = readJsonFile(SETTINGS_FILE, {});
  const updatedSettings = { ...defaults, ...currentSettings };
  writeJsonFile(SETTINGS_FILE, updatedSettings);

  if (callback) callback();
}

// Initialize defaults
initializeDefaults();

module.exports = {
  saveDrone,
  savePackage,
  logEvent,
  addAlert,
  getSettings,
  setSetting,
  getAllDrones: (callback) => {
    const drones = readJsonFile(DRONES_FILE, {});
    const droneArray = Object.values(drones);
    if (callback) callback(null, droneArray);
    return droneArray;
  },
  getAllPackages: (callback) => {
    const packages = readJsonFile(PACKAGES_FILE, {});
    const packageArray = Object.values(packages);
    if (callback) callback(null, packageArray);
    return packageArray;
  },
  getQueuedPackages: (callback) => {
    const packages = readJsonFile(PACKAGES_FILE, {});
    const queued = Object.values(packages).filter(pkg => pkg.status === 'queued');
    if (callback) callback(null, queued);
    return queued;
  },
  getPackageById: (id, callback) => {
    const packages = readJsonFile(PACKAGES_FILE, {});
    const pkg = packages[id] || null;
    if (callback) callback(null, pkg);
    return pkg;
  },
  getAllMissions: (callback) => {
    const missions = readJsonFile(MISSIONS_FILE, {});
    const missionArray = Object.values(missions);
    if (callback) callback(null, missionArray);
    return missionArray;
  },
  getMissionById: (id, callback) => {
    const missions = readJsonFile(MISSIONS_FILE, {});
    const mission = missions[id] || null;
    if (callback) callback(null, mission);
    return mission;
  },
  saveMission: (missionData, callback) => {
    const missions = readJsonFile(MISSIONS_FILE, {});
    missions[missionData.id] = {
      ...missions[missionData.id],
      ...missionData,
      updated_at: Date.now()
    };
    writeJsonFile(MISSIONS_FILE, missions);
    if (callback) callback();
  },
  getRecentLogs: (limit = 50, callback) => {
    const logs = readJsonFile(LOGS_FILE, []);
    const recent = logs.slice(-limit);
    if (callback) callback(null, recent);
    return recent;
  },
  getActiveAlerts: (callback) => {
    const alerts = readJsonFile(ALERTS_FILE, []);
    const active = alerts.filter(alert => !alert.acknowledged);
    if (callback) callback(null, active);
    return active;
  },
  acknowledgeAlert: (id, callback) => {
    const alerts = readJsonFile(ALERTS_FILE, []);
    const alert = alerts.find(a => a.id === id);
    if (alert) {
      alert.acknowledged = true;
      writeJsonFile(ALERTS_FILE, alerts);
    }
    if (callback) callback();
  }
};