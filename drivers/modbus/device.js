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

class ModbusDevice extends SessyBaseDevice {

  async onPoll() {
    // get new status and update the devicestate
    const status = await this.sessy.getStatus({ modbus: true });
    if (this.isUninitialized) return;
    this.setAvailable().catch(() => null);
    await this.updateDeviceState(status);
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

  async onUninit() {
    this.isUninitialized = true;
    await this.stopPolling();
    this.log(`${this.getName()} uninit`);
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

  async updateDeviceState(status) {
    // this.log(`updating states for: ${this.getName()}`);
    try {
      // compensate low power factor
      const { cosphi, useLowPowerCorrection } = this.getSettings();
      let powerL1 = status.phase_1.power;
      let powerL2 = status.phase_2.power;
      let powerL3 = status.phase_3.power;
      let totalPower = status.total_power;
      if (useLowPowerCorrection) {
        if (status.phase_1.power < 25 && status.phase_1.current > 0) powerL1 = Math.round((status.phase_1.current * status.phase_1.voltage * cosphi) / 1000000);
        if (status.phase_2.power < 25 && status.phase_2.current > 0) powerL2 = Math.round((status.phase_2.current * status.phase_2.voltage * cosphi) / 1000000);
        if (status.phase_3.power < 25 && status.phase_3.current > 0) powerL3 = Math.round((status.phase_3.current * status.phase_3.voltage * cosphi) / 1000000);
        totalPower = powerL1 + powerL2 + powerL3;
      }
      // determine capability states
      const systemState = status.state;
      const capabilityStates = {
        measure_power: totalPower,
        system_state: systemState,
        'measure_power.l1': powerL1,
        'measure_power.l2': powerL2,
        'measure_power.l3': powerL3,
        'measure_current.l1': status.phase_1.current / 1000,
        'measure_current.l2': status.phase_2.current / 1000,
        'measure_current.l3': status.phase_3.current / 1000,
        'measure_voltage.l1': status.phase_1.voltage / 1000,
        'measure_voltage.l2': status.phase_2.voltage / 1000,
        'measure_voltage.l3': status.phase_3.voltage / 1000,
        'meter_power.imported': status.total_import / 1000,
        'meter_power.exported': status.total_export / 1000,
      };

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

module.exports = ModbusDevice;
