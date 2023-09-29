/* eslint-disable no-await-in-loop */
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

const { Device } = require('homey');
const util = require('util');
const SessyLocal = require('../../sessy_local');
const SessyCloud = require('../../sessy_cloud');

const setTimeoutPromise = util.promisify(setTimeout);

class P1Device extends Device {

	async onInit() {
		try {
			this.watchDogCounter = 10;
			const settings = this.getSettings();

			this.useCloud = this.homey.platform === 'cloud' || !settings.use_local_connection;
			if (this.useCloud) this.sessy = new SessyCloud(settings);
			else this.sessy = new SessyLocal(settings);

			// start polling device for info
			this.startPolling(settings.pollingInterval || 10);
			this.log('P1 device has been initialized');
		} catch (error) {
			this.error(error);
			this.setUnavailable(error).catch(() => null);
			this.restartDevice(60 * 1000);
		}
	}

	async startPolling(interval) {
		this.homey.clearInterval(this.intervalIdDevicePoll);
		this.log(`start polling ${this.getName()} @${interval} seconds interval`);
		await this.doPoll();
		this.intervalIdDevicePoll = this.homey.setInterval(() => {
			this.doPoll();
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
			this.restarting = false;
			this.onInit();
		} catch (error) {
			this.error(error);
		}
	}

	async doPoll() {
		try {
			if (this.watchDogCounter <= 0) {
				this.log('watchdog triggered, restarting Homey device now');
				this.setCapability('alarm_fault', true);
				this.setUnavailable(this.homey.__('sessy.connectionError')).catch(() => null);
				this.restartDevice(60000);
				return;
			}
			// get new status and update the devicestate
			const status = await this.sessy.getStatus({ p1: true });
			this.setAvailable().catch(() => null);
			await this.updateDeviceState(status);
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
		this.restarting = false;
		this.restartDevice(2 * 1000);
	}

	async onRenamed(name) {
		this.log(`${this.getName()} was renamed to ${name}`);
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

	async updateDeviceState(status) {
		// this.log(`updating states for: ${this.getName()}`);
		try {
			// determine capability states
			const systemState = status.state;
			const capabilityStates = {
				measure_power: status.net_power_delivered * 1000,
				system_state: systemState,
			};

			// setup custom flow triggers
			const systemStateChanged = (systemState !== this.getCapabilityValue('system_state'));

			// set the capabilities
			Object.entries(capabilityStates).forEach(async (entry) => {
				await this.setCapability(entry[0], entry[1]);
			});

			// execute custom flow triggers
			if (systemStateChanged) {
				this.log('System State changed:', systemState);
				const tokens = { system_state: systemState };
				this.homey.app.triggerSystemStateChanged(this, tokens, {});
			}

		} catch (error) {
			this.error(error);
		}
	}

}

module.exports = P1Device;
