/* eslint-disable no-await-in-loop */
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
const SessyLocal = require('../../sessy_local');
// const SessyCloud = require('../../sessy_cloud');
const { migrateCapabilities } = require('../../lib/migrate');

const setTimeoutPromise = (delay) => new Promise((resolve) => {
  // eslint-disable-next-line homey-app/global-timers
  setTimeout(resolve, delay);
});

class CTDevice extends Device {

  async onInit() {
    try {
      this.watchDogCounter = 10;
      this.lastFWCheck = 0;
      const settings = this.getSettings();

      this.useCloud = this.homey.platform === 'cloud'; //  || !settings.use_local_connection;
      this.useLocalLogin = !this.useCloud && settings.sn_dongle !== '' && settings.password_dongle !== '';

      // if (this.useCloud) this.sessy = new SessyCloud(settings); else
      if (settings.use_mdns) await this.discover();
      this.sessy = new SessyLocal(settings);

      // check for capability migration
      await this.migrate();

      // start polling device for info
      await this.startPolling(settings.pollingInterval || 10);
      this.log(`${this.getName()} is initialized`);
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch(() => null);
      await this.restartDevice(60 * 1000).catch(this.error);
    }
  }

  // mDNS related stuff
  async discover() {
    const discoveryStrategy = this.driver.getDiscoveryStrategy();
    const discoveryResults = await discoveryStrategy.getDiscoveryResults();
    if (!discoveryResults) return;
    const [discoveryResult] = Object.values(discoveryResults).filter((disc) => disc.txt.serial === this.getSettings().sn_dongle);
    if (discoveryResult) await this.discoveryAvailable(discoveryResult);
  }

  async discoveryAvailable(discoveryResult) { // onDiscoveryAvailable(discoveryResult)
    // This method will be executed once when the device has been found (onDiscoveryResult returned true)
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
    // Return a truthy value here if the discovery result matches your device.
    return discoveryResult.id === this.getSettings().sn_dongle;
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    // Update your connection details here, reconnect when the device is offline
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
      // this.destroyListeners();
      const dly = delay || 2000;
      this.log(`Device will restart in ${dly / 1000} seconds`);
      // this.setUnavailable('Device is restarting. Wait a few minutes!');
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
      // get new status and update the devicestate
      const energy = await this.sessy.getEnergy().catch(() => this.error('No energy info available'));
      const status = await this.sessy.getStatus({ ct: true });
      this.setAvailable().catch(() => null);
      await this.updateDeviceState(status, energy);
      // check fw every 60 minutes
      if ((this.useCloud || this.useLocalLogin) && (Date.now() - this.lastFWCheck > 60 * 60 * 1000)) {
        this.lastFWCheck = Date.now();
        const OTAstatus = await this.sessy.getOTAStatus();
        await this.updateFWState(OTAstatus);
      }
      this.watchDogCounter = 10;
    } catch (error) {
      this.watchDogCounter -= 1;
      this.error('Poll error', error.message);
    }
  }

  async onAdded() {
    this.log(`${this.getName()} has been added`);
  }

  async onSettings({ newSettings, changedKeys }) { // oldSettings, changedKeys
    this.log(`${this.getName()} settings where changed`, newSettings);
    // check for illegal settings
    if (changedKeys.includes('use_local_connection')) {
      if (this.homey.platform === 'cloud') throw Error(this.homey.__('sessy.homeyProOnly'));
      if (newSettings.host.length < 3) throw Error(this.homey.__('sessy.incomplete'));
    }
    if (newSettings.homey_energy_type === 'solarpanel') {
      this.setEnergy({ cumulative: false }).catch(this.error);
      this.setClass('solarpanel').catch(this.error);
    } else if (newSettings.homey_energy_type === 'cumulative') {
      this.setEnergy({ cumulative: true }).catch(this.error);
      this.setClass('sensor').catch(this.error);
    } else {
      this.setEnergy({ cumulative: false }).catch(this.error);
      this.setClass('sensor').catch(this.error);
    }
    this.restarting = false;
    this.restartDevice(2 * 1000).catch((error) => this.error(error));
    return Promise.resolve(true);
  }

  async onRenamed(name) {
    this.log(`${this.getName()} was renamed to ${name}`);
  }

  async onUninit() {
    this.isUninitialized = true;
    await this.stopPolling();
    this.log(`${this.getName()} uninit`);
  }

  async onDeleted() {
    await this.stopPolling();
    this.log(`${this.getName()} has been deleted`);
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      await this.setCapabilityValue(capability, value)
        .catch((error) => {
          this.log(error, capability, value);
        });
    }
  }

  async updateFWState(OTAStatus) {
    // console.log(`updating OTAstates for: ${this.getName()}`, OTAStatus);
    try {
      const fwDongle = OTAStatus.self.installed_firmware.version;
      const availableFWDongle = OTAStatus.self.available_firmware.version;
      const firmwareDongleChanged = fwDongle !== this.getSettings().fwDongle;
      const newDongleFirmwareAvailable = fwDongle !== availableFWDongle;
      if (firmwareDongleChanged) {
        this.log('The firmware was updated:', fwDongle);
        await this.setSettings({ fwDongle }).catch(this.error);
        const tokens = { fwDongle, fwBat: '' };
        this.homey.app.triggerFirmwareChanged(this, tokens, {});
        const excerpt = this.homey.__('sessy.newFirmwareMeter', { fw: `Dongle: ${fwDongle}` });
        await this.homey.notifications.createNotification({ excerpt });
      }
      if (newDongleFirmwareAvailable && this.availableFWDongle !== availableFWDongle) {
        this.log('New firmware available:', availableFWDongle);
        const tokens = { availableFWDongle, availableFWBat: '' };
        this.homey.app.triggerNewFirmwareAvailable(this, tokens, {});
        this.availableFWDongle = availableFWDongle;
        const excerpt = this.homey.__('sessy.newFirmwareAvailableMeter', { fw: `Dongle: ${availableFWDongle}` });
        await this.homey.notifications.createNotification({ excerpt });
      }
    } catch (error) {
      this.error(error);
    }
  }

  async updateDeviceState(status, energy) {
    // this.log(`updating states for: ${this.getName()}`);
    try {
      // compensate low power factor
      const { cosphi, useLowPowerCorrection } = this.getSettings();
      let powerL1 = status.power_l1;
      let powerL2 = status.power_l2;
      let powerL3 = status.power_l3;
      let totalPower = status.total_power;
      if (useLowPowerCorrection) {
        if (status.power_l1 < 25 && status.current_l1 > 0) powerL1 = Math.round((status.current_l1 * status.voltage_l1 * cosphi) / 1000000);
        if (status.power_l2 < 25 && status.current_l2 > 0) powerL2 = Math.round((status.current_l2 * status.voltage_l2 * cosphi) / 1000000);
        if (status.power_l3 < 25 && status.current_l3 > 0) powerL3 = Math.round((status.current_l3 * status.voltage_l3 * cosphi) / 1000000);
        totalPower = powerL1 + powerL2 + powerL3;
      }
      // determine capability states
      const systemState = status.status;
      const capabilityStates = {
        measure_power: totalPower,
        system_state: systemState,
        'measure_power.l1': powerL1,
        'measure_power.l2': powerL2,
        'measure_power.l3': powerL3,
        'measure_current.l1': status.current_l1 / 1000,
        'measure_current.l2': status.current_l2 / 1000,
        'measure_current.l3': status.current_l3 / 1000,
        'measure_voltage.l1': status.voltage_l1 / 1000,
        'measure_voltage.l2': status.voltage_l2 / 1000,
        'measure_voltage.l3': status.voltage_l3 / 1000,
      };
      if (energy) {
        capabilityStates['meter_power.imported'] = (energy.energy_phase1.import_wh + energy.energy_phase2.import_wh + energy.energy_phase3.import_wh) / 1000;
        capabilityStates['meter_power.exported'] = (energy.energy_phase1.export_wh + energy.energy_phase2.export_wh + energy.energy_phase3.export_wh) / 1000;
        capabilityStates['meter_power.l1Import'] = energy.energy_phase1.import_wh / 1000;
        capabilityStates['meter_power.l1Export'] = energy.energy_phase1.export_wh / 1000;
        capabilityStates['meter_power.l2Import'] = energy.energy_phase2.import_wh / 1000;
        capabilityStates['meter_power.l2Export'] = energy.energy_phase2.export_wh / 1000;
        capabilityStates['meter_power.l3Import'] = energy.energy_phase3.import_wh / 1000;
        capabilityStates['meter_power.l3Export'] = energy.energy_phase3.export_wh / 1000;
      }

      // setup custom flow triggers
      const systemStateChanged = (systemState !== this.getCapabilityValue('system_state'));

      // set the capabilities
      for (const [capability, value] of Object.entries(capabilityStates)) {
        await this.setCapability(capability, value).catch((e) => this.error(e));
      }

      // execute custom flow triggers
      if (systemStateChanged) {
        this.log('System State changed:', systemState);
        const tokens = { system_state: systemState, system_state_details: '' };
        this.homey.app.triggerSystemStateChanged(this, tokens, {});
      }
    } catch (error) {
      this.error(error);
    }
  }

  // flow functions
  async setGridTarget(gridTarget, source) {
    if (!this.useLocalLogin) throw Error(this.homey.__('sessy.controlError'));
    await this.sessy.setGridTarget({ gridTarget });
    this.log(`Grid target set by ${source} to ${gridTarget}`);
    return Promise.resolve(true);
  }

  async restart(source) {
    if (!this.useLocalLogin) throw Error(this.homey.__('sessy.controlError'));
    await this.sessy.restart();
    this.log(`Restart command executed from ${source}`);
    return Promise.resolve(true);
  }

}

module.exports = CTDevice;
