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
// const SessyCloud = require('../../sessy_cloud');

const setTimeoutPromise = util.promisify(setTimeout);

class P1Device extends Device {

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
			this.startPolling(settings.pollingInterval || 10);
			this.log('P1 device has been initialized');
		} catch (error) {
			this.error(error);
			this.setUnavailable(error).catch(() => null);
			this.restartDevice(60 * 1000);
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
		if (this.getSettings().host !== discoveryResult.address) {
			this.log(`${this.getName()} IP address changed to ${discoveryResult.address}`);
			if (this.getSettings().use_mdns) {
				this.setSettings({ host: discoveryResult.address });
				this.restartDevice();
			} else this.log('The IP address is NOT updated (mDNS not enabled)');
		}
	}

	onDiscoveryResult(discoveryResult) {
		// Return a truthy value here if the discovery result matches your device.
		return discoveryResult.id === this.getSettings().sn_dongle;
	}

	onDiscoveryAddressChanged(discoveryResult) {
		// Update your connection details here, reconnect when the device is offline
		this.log('onDiscoveryAddressChanged triggered', this.getName());
		if (this.getSettings().host !== discoveryResult.address) {
			this.log(`${this.getName()} IP address changed to ${discoveryResult.address}`);
			if (this.getSettings().use_mdns) {
				this.setSettings({ host: discoveryResult.address });
				this.restartDevice();
			} else this.log('The IP address is NOT updated (mDNS not enabled)');
		} else this.log('IP address still the same :)');
	}

	async migrate() {
		try {
			this.log(`checking device migration for ${this.getName()}`);

			// store the capability states before migration
			const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
			const state = this[sym];

			// check and repair incorrect capability(order)
			const correctCaps = this.driver.ds.capabilities;
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
						if (state[newCap] !== undefined) this.setCapability(newCap, state[newCap]);
						await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
					}
				}
			}
		} catch (error) {
			this.error(error);
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

	async updateFWState(OTAStatus) {
		// console.log(`updating OTAstates for: ${this.getName()}`, OTAStatus);
		try {
			const fwDongle = OTAStatus.self.installed_firmware.version;
			const availableFWDongle = OTAStatus.self.available_firmware.version;
			const firmwareDongleChanged = fwDongle !== this.getSettings().fwDongle;
			const newDongleFirmwareAvailable = fwDongle !== availableFWDongle;
			if (firmwareDongleChanged) {
				this.log('The firmware was updated:', fwDongle);
				await this.setSettings({ fwDongle });
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
				let T2 = (new Date(`20${d.slice(0, 2)}`, d.slice(2, 4) - 1,	d.slice(4, 6), d.slice(6, 8), d.slice(8, 10), d.slice(10, 2))).valueOf();
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
				measure_power: status.power_total,	// .net_power_delivered * 1000,
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
			Object.entries(capabilityStates).forEach(async (entry) => {
				await this.setCapability(entry[0], entry[1]);
			});

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
