/*
Copyright 2023, Robin de Gruijter (gruijter@hotmail.com)

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
		this.log('Sessy app has been initialized');
	}

	registerFlowListeners() {
		// action cards
		const setPowerSetpoint = this.homey.flow.getActionCard('set_power_setpoint');
		setPowerSetpoint.registerRunListener((args) => args.device.setPowerSetpoint(args.setpoint, 'flow'));

		const setChargeMode = this.homey.flow.getActionCard('set_charge_mode');
		setChargeMode.registerRunListener((args) => args.device.setChargeMode(args.chargeMode, 'flow'));

		const setControlStrategy = this.homey.flow.getActionCard('set_control_strategy');
		setControlStrategy.registerRunListener((args) => args.device.setControlStrategy(args.controlStrategy, 'flow'));

		// trigger cards
		this.triggerSystemStateChanged = (device, tokens, state) => {
			const systemStateChanged = this.homey.flow.getDeviceTriggerCard('system_state_changed');
			systemStateChanged
				.trigger(device, tokens, state)
				.catch(this.error);
		};
		this.triggerChargeModeChanged = (device, tokens, state) => {
			const chargeModeChanged = this.homey.flow.getDeviceTriggerCard('charge_mode_changed');
			chargeModeChanged
				.trigger(device, tokens, state)
				.catch(this.error);
		};
		this.triggerControlStrategyChanged = (device, tokens, state) => {
			const controlStrategyChanged = this.homey.flow.getDeviceTriggerCard('control_strategy_changed');
			controlStrategyChanged
				.trigger(device, tokens, state)
				.catch(this.error);
		};
		this.triggerFirmwareChanged = (device, tokens, state) => {
			const firmwareChanged = this.homey.flow.getDeviceTriggerCard('firmware_changed');
			firmwareChanged
				.trigger(device, tokens, state)
				.catch(this.error);
		};
		this.triggerNewFirmwareAvailable = (device, tokens, state) => {
			const newFirmwareAvailable = this.homey.flow.getDeviceTriggerCard('new_firmware_available');
			newFirmwareAvailable
				.trigger(device, tokens, state)
				.catch(this.error);
		};
	}

}

module.exports = SessyApp;
