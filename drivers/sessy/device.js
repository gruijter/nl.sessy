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
const { migrateCapabilities } = require('../../lib/migrate');

class SessyDevice extends SessyBaseDevice {

  async onInitSpecific() {
    this.busy = false;
    this.batIsFull = false;
    this.batIsEmpty = false;
    this.overrideCounter = 0;
    const settings = this.getSettings();
    // register capability listeners
    await this.registerListeners();

    // set Homey control mode
    if (this.useLocalLogin && settings.force_control_strategy) {
      await this.setControlStrategy('POWER_STRATEGY_API', 'device init');
    }
  }

  async migrate() {
    try {
      const settings = this.getSettings() || {};
      if (settings.username && settings.username !== '' && (!settings.sn_dongle || settings.sn_dongle === '')) {
        this.log('migrating authentication settings from v1', this.getName());
        await this.setSettings({
          sn_dongle: settings.username,
          password_dongle: settings.password,
          use_local_connection: true,
          username: '',
          password: '',
        }).catch(this.error);
        const newSettings = this.getSettings();
        await this.sessy.login(newSettings);
      }

      if (!settings.sn_sessy || settings.sn_sessy === '') {
        const sysInfo = await this.sessy.getSystemInfo().catch(() => { });
        if (sysInfo && sysInfo.sessy_serial) {
          this.log('Setting Sessy S/N', this.getName(), sysInfo.sessy_serial);
          await this.setSettings({ sn_sessy: sysInfo.sessy_serial }).catch(this.error);
        }
      }

      // migrate max charge/discharge settings
      if (this.getSettings().power_max && (!this.getSettings().power_max_charge || !this.getSettings().power_max_discharge)) {
        const maxCharge = this.getSettings().power_max;
        const maxDisCharge = maxCharge > 1800 ? 1800 : maxCharge;
        this.log('migrating max (dis)charge settings', maxCharge, maxDisCharge);
        await this.setSettings({ power_max_charge: maxCharge }).catch(this.error);
        await this.setSettings({ power_max_discharge: maxDisCharge }).catch(this.error);
      }

      // check and repair incorrect capability(order)
      let correctCaps = this.driver.ds.capabilities;
      // remove unwanted PV phase info
      if (!this.getSettings().show_re_total) correctCaps = correctCaps.filter((cap) => !cap.includes('measure_power.total'));
      if (!this.getSettings().show_re1) correctCaps = correctCaps.filter((cap) => !cap.includes('p1'));
      if (!this.getSettings().show_re2) correctCaps = correctCaps.filter((cap) => !cap.includes('p2'));
      if (!this.getSettings().show_re3) correctCaps = correctCaps.filter((cap) => !cap.includes('p3'));

      await migrateCapabilities(this, correctCaps);

      // migrate to Battery class (Homey fw >= 12)
      const deviceClass = this.getClass();
      if (deviceClass !== 'battery') {
        this.log('Converting device class to battery');
        await this.setClass('battery');
      }
    } catch (error) {
      this.error(error);
    }
  }

  async onPoll() {
    if (this.busy) {
      this.log('still busy. skipping a poll');
      return;
    }
    this.busy = true;
    try {
      // get new status and update the devicestate
      const status = await this.sessy.getStatus();
      if (this.isUninitialized) return;
      this.lastStatus = status;
      const energy = await this.sessy.getEnergy().catch(() => this.error('No energy info available'));
      if (this.isUninitialized) return;
      this.lastEnergy = energy;
      this.emitSessyInfo(status, energy);
      const systemSettings = await this.sessy.getSystemSettings().catch(this.error);
      if (this.isUninitialized) return;
      let strategy = null;
      if (this.useCloud || this.useLocalLogin) strategy = await this.sessy.getStrategy();
      if (this.isUninitialized) return;
      this.setAvailable().catch(() => this.error);
      await this.updateDeviceState(status, strategy, energy, systemSettings);
      // check if power is within min/max settings, but only if setpoint is set
      if (status.sessy.power_setpoint) await this.checkMinMaxPower(status.sessy.power);
      // check if battery is empty or full
      await this.checkBatEmptyFull();
      // check fw every 60 minutes
      if ((this.useCloud || this.useLocalLogin) && (Date.now() - this.lastFWCheck > 60 * 60 * 1000)) {
        const OTAstatus = await this.sessy.getOTAStatus();
        if (this.isUninitialized) return;
        await this.updateFWState(OTAstatus);
        this.lastFWCheck = Date.now();
      }
    } finally {
      this.busy = false;
    }
  }

  async onSettingsSpecific({ newSettings, changedKeys }) {
    if (changedKeys.includes('force_control_strategy')) {
      if (this.homey.platform === 'cloud') throw Error(this.homey.__('sessy.homeyProOnly'));
      if (newSettings.host.length < 3 || newSettings.sn_dongle === ''
        || newSettings.password_dongle === '') throw Error(this.homey.__('pair.incomplete'));
    }
  }

  async updateFWState(OTAStatus) {
    // console.log(`updating OTAstates for: ${this.getName()}`, OTAStatus);
    try {
      const fwDongle = OTAStatus.self.installed_firmware.version;
      const fwBat = OTAStatus.serial.installed_firmware.version;
      const availableFWDongle = OTAStatus.self.available_firmware.version;
      const availableFWBat = OTAStatus.serial.available_firmware.version;
      const firmwareDongleChanged = fwDongle !== this.getSettings().fwDongle;
      const firmwareBatChanged = fwBat !== this.getSettings().fwBat;
      const newDongleFirmwareAvailable = fwDongle !== availableFWDongle;
      const newBatFirmwareAvailable = fwBat !== availableFWBat;
      if (firmwareDongleChanged || firmwareBatChanged) {
        this.log('The firmware was updated:', fwDongle, fwBat);
        await this.setSettings({ fwDongle, fwBat }).catch(this.error);
        const tokens = { fwDongle, fwBat };
        this.homey.app.triggerFirmwareChanged(this, tokens, {});
        const excerpt = this.homey.__('sessy.newFirmware', { fw: `Dongle: ${fwDongle}, Bat: ${fwBat}` });
        await this.homey.notifications.createNotification({ excerpt });
      }
      if ((newDongleFirmwareAvailable && this.availableFWDongle !== availableFWDongle)
        || (newBatFirmwareAvailable && this.availableFWBat !== availableFWBat)) {
        this.log('New firmware available:', availableFWDongle, availableFWBat);
        const tokens = { availableFWDongle, availableFWBat };
        this.homey.app.triggerNewFirmwareAvailable(this, tokens, {});
        this.availableFWDongle = availableFWDongle;
        this.availableFWBat = availableFWBat;
        const excerpt = this.homey.__('sessy.newFirmwareAvailable', { fw: `Dongle: ${availableFWDongle}, Bat: ${availableFWBat}` });
        await this.homey.notifications.createNotification({ excerpt });
      }
    } catch (error) {
      this.error(error);
    }
  }

  async updateDeviceState(status, strategy, energy, systemSettings) {
    // this.log(`updating states for: ${this.getName()}`);
    try {
      // determine capability states
      let chargeMode = 'STOP';
      if (status.sessy.power_setpoint < 0) chargeMode = 'CHARGE_ECO';
      if (status.sessy.power_setpoint < -1500) chargeMode = 'CHARGE';
      if (status.sessy.power_setpoint > 0) chargeMode = 'DISCHARGE_ECO';
      if (status.sessy.power_setpoint > 1000) chargeMode = 'DISCHARGE';
      const systemState = status.sessy.system_state.replace('SYSTEM_STATE_', '');
      const alarmFault = systemState.includes('ERROR');
      const totalREPower = status.renewable_energy_phase1.power + status.renewable_energy_phase2.power + status.renewable_energy_phase3.power;
      const controlStrategy = strategy ? strategy.strategy : null;
      const noiseLevel = systemSettings && (systemSettings.allowed_noise_level <= 5) ? systemSettings.allowed_noise_level : 5;
      const capabilityStates = {
        volume_set: noiseLevel,
        control_strategy: controlStrategy,
        override: status.sessy.strategy_overridden,
        charge_mode: chargeMode,
        system_state: systemState,
        system_state_details: status.sessy.system_state_details,
        alarm_fault: alarmFault,
        measure_battery: status.sessy.state_of_charge * 100,
        meter_setpoint: status.sessy.power_setpoint,
        measure_power: -status.sessy.power,
        'measure_power.battery': status.sessy.power,
        measure_frequency: status.sessy.frequency / 1000,
        'measure_power.total': totalREPower,
        'measure_current.inverter': status.sessy.inverter_current_ma / 1000,
        'measure_voltage.pack': status.sessy.pack_voltage / 1000,
        'measure_power.external': status.sessy.external_power,
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
        capabilityStates['meter_power.import'] = energy.sessy_energy.import_wh / 1000;
        capabilityStates['meter_power.export'] = energy.sessy_energy.export_wh / 1000;
        capabilityStates['meter_power.p1Import'] = energy.energy_phase1.import_wh / 1000;
        capabilityStates['meter_power.p1Export'] = energy.energy_phase1.export_wh / 1000;
        capabilityStates['meter_power.p2Import'] = energy.energy_phase2.import_wh / 1000;
        capabilityStates['meter_power.p2Export'] = energy.energy_phase2.export_wh / 1000;
        capabilityStates['meter_power.p3Import'] = energy.energy_phase3.import_wh / 1000;
        capabilityStates['meter_power.p3Export'] = energy.energy_phase3.export_wh / 1000;
      }

      // setup custom flow triggers
      const systemStateChanged = (systemState !== this.getCapabilityValue('system_state'));
      const chargeModeChanged = (chargeMode !== this.getCapabilityValue('charge_mode'));
      const controlStrategyChanged = (controlStrategy && (controlStrategy !== this.getCapabilityValue('control_strategy')));

      // set the capabilities
      for (const [capability, value] of Object.entries(capabilityStates)) {
        // await each call to properly handle promises and avoid returning a Promise from forEach
        if (this.isUninitialized) return;
        await this.setCapability(capability, value).catch((e) => this.error(e));
      }

      // execute custom flow triggers
      if (systemStateChanged) {
        this.log('System State changed:', systemState);
        const tokens = { system_state: systemState, system_state_details: capabilityStates.system_state_details };
        this.homey.app.triggerSystemStateChanged(this, tokens, {});
      }
      if (chargeModeChanged) {
        this.log('Charge Mode changed:', chargeMode);
        const tokens = { charge_mode: chargeMode };
        this.homey.app.triggerChargeModeChanged(this, tokens, {});
      }
      if (controlStrategyChanged) {
        this.log('Control Strategy changed:', controlStrategy);
        const tokens = { control_strategy: controlStrategy };
        this.homey.app.triggerControlStrategyChanged(this, tokens, {});
      }
    } catch (error) {
      this.error(error);
    }
  }

  // check if min/max power reached, and override setpoint if needed
  async checkMinMaxPower(power) {
    let overrideSP = power;
    if (typeof power === 'number') {
      overrideSP = await this.limitSetpoint(power);
      if (overrideSP !== power) this.overrideCounter += 1;
      else this.overrideCounter = 0;
      if (this.overrideCounter >= 3) await this.setPowerSetpoint(overrideSP, 'min_max intervention'); // intervene: set to 0 or to max
    }
  }

  // detect empty or full battery
  async checkBatEmptyFull() {
    const state = this.getCapabilityValue('system_state');
    const soc = this.getCapabilityValue('measure_battery');
    if (state === 'BATTERY_EMPTY') this.batIsEmpty = true;
    else if (state === 'BATTERY_FULL') this.batIsFull = true;
    else if (state === 'BATTERY_EMPTY_OR_FULL') {
      if (soc < 5) this.batIsEmpty = true;
      if (soc > 95) this.batIsFull = true;
    } else if (this.overrideCounter >= 3) {
      if (soc < 1) this.batIsEmpty = true;
      if (soc > 99) this.batIsFull = true;
    } else {
      if (soc >= 1) this.batIsEmpty = false;
      if (soc <= 99) this.batIsFull = false;
    }
  }

  // limit min/max setpoint
  async limitSetpoint(setpoint) {
    let sp = setpoint;
    if (sp && this.getCapabilityValue('control_strategy') === 'POWER_STRATEGY_API') {
      // apply battery full_empty protection
      if (this.batIsEmpty && sp > 0) sp = 0; // don't discharge when bat is empty
      if (this.batIsFull && sp < 0) sp = 0; // don't charge when bat is full
      // apply min_max settings
      if (setpoint < 0) { // set to charging
        const min = this.getSettings().power_min;
        const max = this.getSettings().power_max_charge;
        sp = (sp + min) > 0 ? 0 : sp; // don't charge below lower threshold
        sp = (sp + max) < -10 ? -max : sp; // cap to max threshold + 10
      }
      if (setpoint > 0) { // set to discharging
        const min = this.getSettings().power_min;
        const max = this.getSettings().power_max_discharge;
        sp = (sp - min) < 0 ? 0 : sp; // don't (dis)charge below lower threshold
        sp = (sp - max) > 10 ? max : sp; // cap to max threshold + 10
      }
    }
    return sp;
  }

  async setControlStrategy(strategy, source) {
    if (!this.useLocalLogin) throw Error(this.homey.__('sessy.controlError'));
    await this.sessy.setStrategy({ strategy });
    this.log(`Control Strategy set by ${source} to ${strategy}`);
    return Promise.resolve(true);
  }

  async setChargeMode(chargeMode, source) {
    if (this.getCapabilityValue('control_strategy') !== 'POWER_STRATEGY_API') {
      if (this.getSettings().force_control_strategy) await this.setControlStrategy('POWER_STRATEGY_API', 'control attempt');
      else throw Error(this.homey.__('sessy.controlError'));
    }
    let setpoint = 0;
    switch (chargeMode) {
      case 'STOP':
        setpoint = 0;
        break;
      case 'CHARGE':
        setpoint = -2200;
        break;
      case 'CHARGE_ECO':
        setpoint = -1050;
        break;
      case 'DISCHARGE':
        setpoint = 1800;
        break;
      case 'DISCHARGE_ECO':
        setpoint = 765;
        break;
      default: setpoint = 0;
    }
    await this.setPowerSetpoint(setpoint, source);
    this.log(`Charge Mode set by ${source} to ${chargeMode}`);
    return Promise.resolve(true);
  }

  async setPowerSetpoint(setpoint, source) {
    // force Homey as controller
    if (this.getCapabilityValue('control_strategy') !== 'POWER_STRATEGY_API') {
      if (this.getSettings().force_control_strategy) await this.setControlStrategy('POWER_STRATEGY_API', 'control attempt');
      else throw Error(this.homey.__('sessy.controlError'));
    }
    // limit min/max power
    const sp = await this.limitSetpoint(setpoint);
    await this.sessy.setSetpoint({ setpoint: sp });
    this.log(`${this.getName()} Power setpoint set by ${source} to ${sp}`);
    return Promise.resolve(true);
  }

  async setMinPower(setpoint, source) {
    await this.sessy.setSystemSettings({ min_power: setpoint });
    this.log(`Min power set by ${source} to ${setpoint}`);
    return Promise.resolve(true);
  }

  async setMaxPower(setpoint, source) {
    await this.sessy.setSystemSettings({ max_power: setpoint });
    this.log(`Max power set by ${source} to ${setpoint}`);
    return Promise.resolve(true);
  }

  async setAllowedNoiseLevel(setpoint, source) {
    await this.sessy.setSystemSettings({ allowed_noise_level: setpoint });
    this.log(`Max noise level set by ${source} to ${setpoint}`);
    return Promise.resolve(true);
  }

  async restart(source) {
    if (!this.useLocalLogin) throw Error(this.homey.__('sessy.controlError'));
    await this.sessy.restart();
    this.log(`Restart command executed from ${source}`);
    return Promise.resolve(true);
  }

  emitSessyInfo(status, energy) {
    try {
      this.homey.emit('sessyInfo', { id: this.getData().id, status, energy }); // emit info to PV devices
    } catch (error) {
      this.error(error);
    }
  }

  // register capability listeners
  registerListeners() {
    try {
      if (this.listenersSet) return true;
      this.log('registering listeners');

      // capabilityListeners will be overwritten, so no need to unregister them
      this.registerCapabilityListener('control_strategy', (strategy) => this.setControlStrategy(strategy, 'app'));
      this.registerCapabilityListener('charge_mode', (chargeMode) => this.setChargeMode(chargeMode, 'app'));
      this.registerCapabilityListener('meter_setpoint', (setpoint) => this.setPowerSetpoint(setpoint, 'app'));
      this.registerCapabilityListener('volume_set', (setpoint) => this.setAllowedNoiseLevel(setpoint, 'app'));

      this.listenersSet = true;
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

}

module.exports = SessyDevice;
