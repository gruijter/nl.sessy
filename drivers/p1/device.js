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

class P1Device extends SessyBaseDevice {

  async onPoll() {
    // get new status and update the devicestate
    const status = await this.sessy.getStatus({ p1: true });
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
      // calculate gas usage
      let gasFlow = this.getCapabilityValue('measure_gas');
      if (this.lastStatus && this.lastStatus.gas_meter_value_time && this.lastStatus.gas_meter_value_time.length === 13
        && status.gas_meter_value_time && status.gas_meter_value_time.length === 13) {
        let d = status.gas_meter_value_time; // "231125175508W" YYMMDDhhmmssX
        let T2 = (new Date(`20${d.slice(0, 2)}`, d.slice(2, 4) - 1, d.slice(4, 6), d.slice(6, 8), d.slice(8, 10), d.slice(10, 2))).valueOf();
        if (d[11] === 'S') T2 -= 3600 * 1000; // substract an hour when on DST
        d = this.lastStatus.gas_meter_value_time; // "231125175508W" YYMMDDhhmmssX
        let T1 = (new Date(`20${d.slice(0, 2)}`, d.slice(2, 4) - 1, d.slice(4, 6), d.slice(6, 8), d.slice(8, 10), d.slice(10, 2))).valueOf();
        if (d[11] === 'S') T1 -= 3600 * 1000; // substract an hour when on DST
        const usedGas = (status.gas_meter_value - this.lastStatus.gas_meter_value) / 1000; // m3
        const deltaT = (T2 - T1) / 1000 / 60 / 60; // hour
        if (deltaT > 0) gasFlow = usedGas / deltaT;
      }

      // determine capability states
      const systemState = status.state;
      const capabilityStates = {
        measure_power: status.power_total, // .net_power_delivered * 1000,
        system_state: systemState,
        meter_offPeak: status.tariff_indicator === 1,
        'measure_power.l1': status.power_consumed_l1 - status.power_produced_l1,
        'measure_power.l2': status.power_consumed_l2 - status.power_produced_l2,
        'measure_power.l3': status.power_consumed_l3 - status.power_produced_l3,
        'measure_current.l1': status.current_l1 / 1000,
        'measure_current.l2': status.current_l2 / 1000,
        'measure_current.l3': status.current_l3 / 1000,
        'measure_voltage.l1': status.voltage_l1 / 1000,
        'measure_voltage.l2': status.voltage_l2 / 1000,
        'measure_voltage.l3': status.voltage_l3 / 1000,
        'meter_power.imported': (status.power_consumed_tariff1 + status.power_consumed_tariff2) / 1000,
        'meter_power.exported': (status.power_produced_tariff1 + status.power_produced_tariff2) / 1000,
        'meter_power.peak': status.power_consumed_tariff2 / 1000,
        'meter_power.offPeak': status.power_consumed_tariff1 / 1000,
        'meter_power.producedPeak': status.power_produced_tariff2 / 1000,
        'meter_power.producedOffPeak': status.power_produced_tariff1 / 1000,
        meter_power: (status.power_consumed_tariff2 + status.power_consumed_tariff1
          - status.power_produced_tariff2 - status.power_produced_tariff1) / 1000,
        meter_power_failure: status.power_failure_any_phase,
        meter_voltage_sag: status.voltage_sag_count_l1 + status.voltage_sag_count_l2 + status.voltage_sag_count_l3,
        meter_voltage_swell: status.voltage_swell_count_l1 + status.voltage_swell_count_l2 + status.voltage_swell_count_l3,
        meter_gas: status.gas_meter_value / 1000,
        measure_gas: gasFlow,
      };

      // setup custom flow triggers
      const systemStateChanged = (systemState !== this.getCapabilityValue('system_state'));

      // set the capabilities
      for (const [capability, value] of Object.entries(capabilityStates)) {
        if (this.isUninitialized) return;
        await this.setCapability(capability, value).catch((e) => this.error(e));
      }

      this.lastStatus = status;

      // execute custom flow triggers
      if (systemStateChanged) {
        this.log('System State changed:', systemState);
        const tokens = { system_state: systemState, system_state_details: '' };
        this.homey.app.triggerSystemStateChanged(this, tokens, {});
      }
      const tariffChanged = capabilityStates.meter_offPeak !== this.getCapabilityValue('meter_offPeak');
      if (tariffChanged) {
        this.log('Tariff changed. offPeak:', capabilityStates.meter_offPeak);
        const tokens = { tariff: capabilityStates.meter_offPeak };
        this.homey.app.triggerTariffChanged(this, tokens, {});
      }

      // update DSMR info
      if (this.getSettings().DSMR !== status.toString()) this.setSettings({ DSMR: status.dsmr_version.toString() }).catch(this.error);
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

module.exports = P1Device;
