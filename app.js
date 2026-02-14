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

const Homey = require('homey');

class SessyApp extends Homey.App {

  async onInit() {
    this.registerFlowListeners();
    this.everyHour();
    this.log('Sessy app has been initialized');
  }

  async onUninit() {
    this.log('app onUninit called');
    if (this.everyHourTimer) this.homey.clearTimeout(this.everyHourTimer);
    if (this.everyHourInterval) this.homey.clearInterval(this.everyHourInterval);
    this.homey.removeAllListeners('everyhour');
    this.homey.removeAllListeners('sessyInfo');
  }

  everyHour() {
    const now = new Date();
    const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 50);
    const timeToNextHour = nextHour - now;
    // console.log('everyHour starts in', timeToNextHour / 1000);
    this.everyHourTimer = this.homey.setTimeout(() => {
      this.everyHourInterval = this.homey.setInterval(async () => {
        this.homey.emit('everyhour', true);
      }, 60 * 60 * 1000);
      this.homey.emit('everyhour', true);
    }, timeToNextHour);
    this.log('everyHour job started');
  }

  registerFlowListeners() {
    // action cards
    const setPowerSetpoint = this.homey.flow.getActionCard('set_power_setpoint');
    setPowerSetpoint.registerRunListener((args) => args.device.setPowerSetpoint(args.setpoint, 'flow'));

    const setChargeMode = this.homey.flow.getActionCard('set_charge_mode');
    setChargeMode.registerRunListener((args) => args.device.setChargeMode(args.chargeMode, 'flow'));

    const setControlStrategy = this.homey.flow.getActionCard('set_control_strategy');
    setControlStrategy.registerRunListener((args) => args.device.setControlStrategy(args.controlStrategy, 'flow'));

    const setGridtarget = this.homey.flow.getActionCard('set_grid_target');
    setGridtarget.registerRunListener((args) => args.device.setGridTarget(args.gridTarget, 'flow'));

    const setAllowedNoiseLevel = this.homey.flow.getActionCard('volume_set');
    setAllowedNoiseLevel.registerRunListener((args) => args.device.setAllowedNoiseLevel(args.setpoint, 'flow'));

    const setMaxPower = this.homey.flow.getActionCard('set_max_power');
    setMaxPower.registerRunListener((args) => args.device.setMaxPower(args.setpoint, 'flow'));

    const setMinPower = this.homey.flow.getActionCard('set_min_power');
    setMinPower.registerRunListener((args) => args.device.setMinPower(args.setpoint, 'flow'));

    const restart = this.homey.flow.getActionCard('restart');
    restart.registerRunListener((args) => args.device.restart('flow'));

    // trigger cards
  }

  triggerSystemStateChanged(device, tokens, state) {
    const systemStateChanged = this.homey.flow.getDeviceTriggerCard('system_state_changed');
    systemStateChanged
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  triggerChargeModeChanged(device, tokens, state) {
    const chargeModeChanged = this.homey.flow.getDeviceTriggerCard('charge_mode_changed');
    chargeModeChanged
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  triggerControlStrategyChanged(device, tokens, state) {
    const controlStrategyChanged = this.homey.flow.getDeviceTriggerCard('control_strategy_changed');
    controlStrategyChanged
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  triggerFirmwareChanged(device, tokens, state) {
    const firmwareChanged = this.homey.flow.getDeviceTriggerCard('firmware_changed');
    firmwareChanged
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  triggerNewFirmwareAvailable(device, tokens, state) {
    const newFirmwareAvailable = this.homey.flow.getDeviceTriggerCard('new_firmware_available');
    newFirmwareAvailable
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  triggerTariffChanged(device, tokens, state) {
    const tariffChanged = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    tariffChanged
      .trigger(device, tokens, state)
      .catch(this.error);
  }

}

module.exports = SessyApp;
