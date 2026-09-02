const { relayCommand } = require('./server');

class SerialMavlinkAdapter {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'http://localhost:3000';
    this.target = options.target || 'DRONE0001';
    this.intervalMs = options.intervalMs || 5000;
    this.running = false;
    this.timer = null;
  }

  async sendCommand(action, extra = {}) {
    return relayCommand({
      action,
      target: extra.target || this.target,
      protocol: 'mavlink',
      targetSystem: extra.targetSystem || 1,
      targetComponent: extra.targetComponent || 1,
      params: extra.params || [0, 0, 0, 0, 0, 0, 0],
      ...extra
    });
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        await this.sendCommand('HEARTBEAT', {
          target: this.target,
          targetSystem: 1,
          targetComponent: 1,
          params: [0, 0, 0, 0, 0, 0, 0]
        });
      } catch (error) {
        console.warn('Serial MAVLink adapter heartbeat error:', error.message);
      }
    }, this.intervalMs);

    console.log(`Serial MAVLink adapter started for ${this.target}`);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('Serial MAVLink adapter stopped');
  }
}

module.exports = { SerialMavlinkAdapter };

if (require.main === module) {
  const adapter = new SerialMavlinkAdapter({ target: process.env.TARGET_DRONE || 'DRONE0001' });
  adapter.start();

  process.on('SIGINT', () => {
    adapter.stop();
    process.exit(0);
  });
}
