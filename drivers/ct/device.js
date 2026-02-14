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

const SessyBaseDevice = require('../../lib/base_device');

class CTDevice extends SessyBaseDevice {

  async onPoll() {
    // get new status and update the devicestate
    const energy = await this.sessy.getEnergy().catch(() => this.error('No energy info available'));
    if (this.isUninitialized) return;
    const status = await this.sessy.getStatus({ ct: true });
    if (this.isUninitialized) return;
    this.setAvailable().catch(() => null);
    await this.updateDeviceState(status, energy);
    // check fw every 60 minutes
    if ((this.useCloud || this.useLocalLogin) && (Date.now() - this.lastFWCheck > 60 * 60 * 1000)) {
      this.lastFWCheck = Date.now();
      const OTAstatus = await this.sessy.getOTAStatus();
      if (this.isUninitialized) return;
      await this.updateFWState(OTAstatus);
    }
  }

  async onSettingsSpecific({ newSettings }) {
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
        if (this.isUninitialized) return;
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
