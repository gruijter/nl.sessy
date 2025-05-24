/* eslint-disable no-await-in-loop */
/*
Copyright 2023 - 2025, Robin de Gruijter (gruijter@hotmail.com)

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
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

class PVDevice extends Device {

  async onInit() {
    try {
      // check for capability migration
      await this.migrate();
      // start listening to source Sessy device for info
      this.startWatchdog();
      this.startListeners();
      this.log(`${this.getName()} is initialized`);
    } catch (error) {
      this.error(error);
      this.setUnavailable(error).catch(() => null);
      await this.restartDevice(60 * 1000).catch(this.error);
    }
  }

  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      // store the capability states before migration
      const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
      const state = this[sym];
      // check and repair incorrect capability(order)
      let correctCaps = this.driver.ds.capabilities;
      // remove unwanted PV phase info
      const showRe1 = this.getSettings().show_re1;
      const showRe2 = this.getSettings().show_re2;
      const showRe3 = this.getSettings().show_re3;
      const onlyShowTotalPower = [showRe1, showRe2, showRe3].filter(Boolean).length < 2;
      if (!showRe1) correctCaps = correctCaps.filter((cap) => !cap.includes('p1'));
      if (!showRe2) correctCaps = correctCaps.filter((cap) => !cap.includes('p2'));
      if (!showRe3) correctCaps = correctCaps.filter((cap) => !cap.includes('p3'));
      if (onlyShowTotalPower) correctCaps = correctCaps.filter((cap) => !cap.includes('measure_power.p'));
      for (let index = 0; index <= correctCaps.length; index += 1) {
        const caps = await this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          this.setUnavailable(this.homey.__('sessy.migrating')).catch(() => null);
          // remove all caps from here
          for (let i = index; i < caps.length; i += 1) {
            this.log(`removing capability ${caps[i]} for ${this.getName()}`);
            await this.removeCapability(caps[i])
              .catch((error) => this.log(error));
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
          // add the new cap
          if (newCap !== undefined) {
            this.log(`adding capability ${newCap} for ${this.getName()}`);
            await this.addCapability(newCap);
            // restore capability state
            if (state[newCap]) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
            // else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
            if (state[newCap] !== undefined) await this.setCapability(newCap, state[newCap]).catch(this.error);
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
        }
      }
    } catch (error) {
      this.error(error);
    }
  }

  async restartDevice(delay) {
    try {
      if (this.restarting) return;
      this.restarting = true;
      this.destroyListeners();
      const dly = delay || 2000;
      this.log(`Device will restart in ${dly / 1000} seconds`);
      // this.setUnavailable('Device is restarting. Wait a few minutes!');
      await setTimeoutPromise(dly);
      this.restarting = false;
      this.onInit().catch((error) => this.error(error));
    } catch (error) {
      this.error(error);
    }
  }

  async onAdded() {
    this.log(`${this.getName()} has been added`);
  }

  async onSettings({ newSettings, changedKeys }) { // oldSettings, changedKeys
    this.log(`${this.getName()} settings where changed`, newSettings);
    this.restarting = false;
    this.restartDevice(2 * 1000).catch((error) => this.error(error));
  }

  async onRenamed(name) {
    this.log(`${this.getName()} was renamed to ${name}`);
  }

  async onUninit() {
    if (this.watchdog) this.homey.clearInterval(this.watchdog);
    this.destroyListeners();
    this.log(`${this.getName()} uninit`);
  }

  async onDeleted() {
    if (this.watchdog) this.homey.clearInterval(this.watchdog);
    this.destroyListeners();
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

  async updateDeviceState(status, energy) {
    // this.log(`updating states for: ${this.getName()}`);
    try {
      this.lastPoll = Date.now();
      await this.setAvailable().catch((error) => this.error(error));
      // determine capability states
      const totalREPower = status.renewable_energy_phase1.power + status.renewable_energy_phase2.power + status.renewable_energy_phase3.power;
      const capabilityStates = {
        measure_power: totalREPower,
        measure_frequency: status.sessy.frequency / 1000,
        'measure_power.p1': status.renewable_energy_phase1.power,
        'measure_power.p2': status.renewable_energy_phase2.power,
        'measure_power.p3': status.renewable_energy_phase3.power,
        'measure_current.p1': status.renewable_energy_phase1.current_rms / 1000,
        'measure_current.p2': status.renewable_energy_phase2.current_rms / 1000,
        'measure_current.p3': status.renewable_energy_phase3.current_rms / 1000,
        'measure_voltage.p1': status.renewable_energy_phase1.voltage_rms / 1000,
        'measure_voltage.p2': status.renewable_energy_phase2.voltage_rms / 1000,
        'measure_voltage.p3': status.renewable_energy_phase3.voltage_rms / 1000,
      };
      if (energy) {
        capabilityStates['meter_power'] = (energy.energy_phase1.export_wh + energy.energy_phase2.export_wh + energy.energy_phase3.export_wh
          - energy.energy_phase1.import_wh - energy.energy_phase2.import_wh - energy.energy_phase3.import_wh) / 1000;
        capabilityStates['meter_power.p1Import'] = energy.energy_phase1.import_wh / 1000;
        capabilityStates['meter_power.p1Export'] = energy.energy_phase1.export_wh / 1000;
        capabilityStates['meter_power.p2Import'] = energy.energy_phase2.import_wh / 1000;
        capabilityStates['meter_power.p2Export'] = energy.energy_phase2.export_wh / 1000;
        capabilityStates['meter_power.p3Import'] = energy.energy_phase3.import_wh / 1000;
        capabilityStates['meter_power.p3Export'] = energy.energy_phase3.export_wh / 1000;
      }
      // set the capabilities
      Object.entries(capabilityStates).forEach(async (entry) => {
        await this.setCapability(entry[0], entry[1]);
      });
    } catch (error) {
      this.error(error);
    }
  }

  // start watchdog
  startWatchdog() {
    if (this.watchdog) this.homey.clearInterval(this.watchdog);
    this.log('starting watchdog for', this.getName());
    this.lastPoll = Date.now();
    this.watchdog = this.homey.setInterval(() => {
      if ((Date.now() - this.lastPoll) > 10 * 60 * 1000) {
        this.setUnavailable(this.homey.__('pv.no_updates')).catch((error) => this.error(error));
      }
    }, 10 * 60 * 1000); // check every 10 minutes
  }

  // start listeners
  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.eventListenerSessyInfo = (sessyInfo) => {
      if (sessyInfo.id === this.getData().id) this.updateDeviceState(sessyInfo.status, sessyInfo.energy).catch((error) => this.error(error));
    };
    this.homey.on('sessyInfo', this.eventListenerSessyInfo);
  }

  // remove listeners
  destroyListeners() {
    this.log('removing listeners', this.getName());
    if (this.eventListenerSessyInfo) this.homey.removeListener('sessyInfo', this.eventListenerSessyInfo);
  }

}

module.exports = PVDevice;
