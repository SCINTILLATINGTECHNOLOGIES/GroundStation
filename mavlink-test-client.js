const DEFAULT_SERVER = process.env.MAVLINK_SERVER_URL || 'http://localhost:3000';

async function httpJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = { raw: text };
  }

  if (!response.ok) {
    const message = json && json.error ? json.error : text || 'request failed';
    throw new Error(message);
  }

  return json;
}

async function sendCommand(action, extra = {}, server = DEFAULT_SERVER) {
  const payload = {
    action,
    protocol: 'mavlink',
    target: extra.target || 'DRONE0001',
    targetSystem: extra.targetSystem || 1,
    targetComponent: extra.targetComponent || 1,
    params: extra.params || [0, 0, 0, 0, 0, 0, 0],
    ...extra
  };

  const response = await httpJson(`${server}/api/mavlink/command`, payload);
  console.log(`Sent ${action}:`, JSON.stringify(response, null, 2));
  return response;
}

async function main() {
  const server = process.argv[2] || DEFAULT_SERVER;
  console.log(`Connecting to MAVLink bridge at ${server}`);

  const health = await fetch(`${server}/api/mavlink/health`).then((res) => res.json());
  console.log('Health:', JSON.stringify(health, null, 2));

  await sendCommand('ARM', { target: 'DRONE0001', targetSystem: 1, targetComponent: 1 });
  await sendCommand('TAKEOFF', {
    target: 'DRONE0001',
    targetSystem: 1,
    targetComponent: 1,
    params: [0, 0, 0, 0, 0, 0, 0],
    latitude: 6.5774,
    longitude: 3.3212,
    altitude: 50
  });
  await sendCommand('WAYPOINT', {
    target: 'DRONE0001',
    targetSystem: 1,
    targetComponent: 1,
    params: [0, 0, 0, 0, 6.5774, 3.3212, 50],
    latitude: 6.5774,
    longitude: 3.3212,
    altitude: 50
  });
}

main().catch((error) => {
  console.error('MAVLink test client failed:', error.message);
  process.exitCode = 1;
});
