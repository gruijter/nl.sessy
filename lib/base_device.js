/*
Copyright 2023 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of nl.sessy.

nl.sessy is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

nl.sessy is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with nl.sessy. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const { Device } = require('homey');
const SessyLocal = require('../sessy_local');
const { migrateCapabilities } = require('./migrate');
const { setTimeoutPromise } = require('./util');

class SessyBaseDevice extends Device {

  async onInit() {
    try {
      this.watchDogCounter = 10;
      this.lastFWCheck = 0;
      const settings = this.getSettings();

      this.useCloud = this.homey.platform === 'cloud';
      this.useLocalLogin = !this.useCloud && settings.sn_dongle !== '' && settings.password_dongle !== '';

      if (settings.use_mdns) await this.discover();
      this.sessy = new SessyLocal(settings);

      await this.migrate();

      if (this.onInitSpecific) await this.onInitSpecific();

      const pollingInterval = this.homey.platform === 'cloud' ? 10 : (settings.pollingInterval || 10);
      await this.startPolling(pollingInterval);
      this.log(`${this.getName()} is initialized`);
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch(() => null);
      await this.restartDevice(60 * 1000).catch(this.error);
    }
  }

  async discover() {
    const discoveryStrategy = this.driver.getDiscoveryStrategy();
    const discoveryResults = await discoveryStrategy.getDiscoveryResults();
    if (!discoveryResults) return;
    const [discoveryResult] = Object.values(discoveryResults).filter((disc) => disc.txt.serial === this.getSettings().sn_dongle);
    if (discoveryResult) await this.discoveryAvailable(discoveryResult);
  }

  async discoveryAvailable(discoveryResult) {
    if (!discoveryResult) return;
    if (this.getSettings().host !== discoveryResult.address) {
      this.log(`${this.getName()} IP address changed to ${discoveryResult.address}`);
      if (this.getSettings().use_mdns) {
        this.setSettings({ host: discoveryResult.address }).catch(this.error);
        await this.restartDevice().catch(this.error);
      } else this.log('The IP address is NOT updated (mDNS not enabled)');
    }
  }

  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getSettings().sn_dongle;
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    this.log('onDiscoveryAddressChanged triggered', this.getName());
    if (this.getSettings().host !== discoveryResult.address) {
      this.log(`${this.getName()} IP address changed to ${discoveryResult.address}`);
      if (this.getSettings().use_mdns) {
        this.setSettings({ host: discoveryResult.address }).catch(this.error);
        await this.restartDevice().catch(this.error);
      } else this.log('The IP address is NOT updated (mDNS not enabled)');
    } else this.log('IP address still the same :)');
  }

  async migrate() {
    try {
      await migrateCapabilities(this, this.driver.ds.capabilities);
    } catch (error) {
      this.error(error);
    }
  }

  async startPolling(interval) {
    this.homey.clearInterval(this.intervalIdDevicePoll);
    this.log(`start polling ${this.getName()} @${interval} seconds interval`);
    await this.doPoll();
    this.intervalIdDevicePoll = this.homey.setInterval(async () => {
      await this.doPoll().catch(this.error);
    }, interval * 1000);
  }

  async stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    this.homey.clearInterval(this.intervalIdDevicePoll);
  }

  async restartDevice(delay) {
    try {
      if (this.restarting) return;
      this.restarting = true;
      await this.stopPolling();
      const dly = delay || 2000;
      this.log(`Device will restart in ${dly / 1000} seconds`);
      await setTimeoutPromise(dly);
      if (this.isUninitialized) return;
      this.restarting = false;
      this.onInit().catch((error) => this.error(error));
    } catch (error) {
      this.error(error);
    }
  }

  async doPoll() {
    try {
      if (this.watchDogCounter <= 0) {
        this.log('watchdog triggered, restarting Homey device now');
        await this.setCapability('alarm_fault', true).catch(this.error);
        this.setUnavailable(this.homey.__('sessy.connectionError')).catch(() => null);
        await this.restartDevice(60000).catch(this.error);
        return;
      }
      await this.onPoll();
      this.watchDogCounter = 10;
    } catch (error) {
      this.watchDogCounter -= 1;
      this.error('Poll error', error.message || error);
    }
  }

  async onAdded() {
    this.log(`${this.getName()} has been added`);
  }

  async onSettings({ newSettings, changedKeys }) {
    this.log(`${this.getName()} settings where changed`, newSettings);
    if (changedKeys.includes('use_local_connection')) {
      if (this.homey.platform === 'cloud') throw Error(this.homey.__('sessy.homeyProOnly'));
      if (newSettings.host.length < 3) throw Error(this.homey.__('sessy.incomplete'));
    }
    if (this.onSettingsSpecific) await this.onSettingsSpecific({ newSettings, changedKeys });
    this.restarting = false;
    this.restartDevice(2 * 1000).catch((error) => this.error(error));
    return Promise.resolve(true);
  }

  async onRenamed(name) {
    this.log(`${this.getName()} was renamed to ${name}`);
  }
}

module.exports = SessyBaseDevice;
