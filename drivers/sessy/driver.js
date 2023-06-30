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

const { Driver } = require('homey');
const Sessy = require('../../sessy');

const capabilities = [
	'charge_mode',
	'measure_battery',

	'measure_power',
	'meter_setpoint',
	'measure_frequency',
	'system_state',
	'alarm_fault',
	'control_strategy',

	'measure_power.total',

	'measure_power.p1',
	'measure_voltage.p1',
	'measure_current.p1',

	'measure_power.p2',
	'measure_voltage.p2',
	'measure_current.p2',

	'measure_power.p3',
	'measure_current.p3',
	'measure_voltage.p3',
];

class SessyDriver extends Driver {

	async onInit() {
		this.ds = { capabilities };
		this.log('Sessy driver has been initialized');
	}

	async onPair(session) {

		session.setHandler('manual', async (conSett) => {
			try {
				this.log(conSett);
				const settings = conSett;
				const SESSY = new Sessy(settings);
				// check credentials and get status info
				const status = await SESSY.getStatus();
				// get MAC info if available
				const mac = await this.homey.arp.getMAC(settings.host).catch(() => '');
				let MAC = mac.replace(/:/g, '').toUpperCase();
				if (MAC === '') MAC = Math.random().toString(16).substring(2, 8);
				// remove PV info when phase not connected
				const showRe1 = status && status.renewable_energy_phase1 && status.renewable_energy_phase1.voltage_rms > 0;
				const showRe2 = status && status.renewable_energy_phase2 && status.renewable_energy_phase2.voltage_rms > 0;
				const showRe3 = status && status.renewable_energy_phase3 && status.renewable_energy_phase3.voltage_rms > 0;
				const showReTotal = showRe1 + showRe2 + showRe3 > 1;
				let correctCaps = capabilities;
				if (!showReTotal) correctCaps = correctCaps.filter((cap) => !cap.includes('measure_power.total'));
				if (!showRe1) correctCaps = correctCaps.filter((cap) => !cap.includes('p1'));
				if (!showRe2) correctCaps = correctCaps.filter((cap) => !cap.includes('p2'));
				if (!showRe3) correctCaps = correctCaps.filter((cap) => !cap.includes('p3'));
				// get fwLevel
				// const OTAstatus = await SESSY.getOTAStatus();
				// const fw_dongle = OTAstatus.self.installed_firmware.version;
				// const fw_bat = OTAstatus.serial.installed_firmware.version;
				const device = {
					name: `SESSY_${settings.host}`,
					data: {
						id: MAC,
					},
					capabilities: correctCaps,
					settings: {
						username: settings.username,
						password: settings.password,
						host: settings.host,
						port: settings.port,
						mac,
						// fw_dongle, fw_bat,
						show_re_total: showReTotal,
						show_re1: showRe1,
						show_re2: showRe2,
						show_re3: showRe3,
						force_control_strategy: true,
					},
				};
				return Promise.resolve(device);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('list_devices', async () => {
			try {
				const SESSY = new Sessy();
				const discovered = await SESSY.discover().catch(() => []);
				const allDevicesPromise = discovered.map(async (sessy) => {
					// try to find the MAC
					const mac = await this.homey.arp.getMAC(sessy.ip).catch(() => '');
					let MAC = mac.replace(/:/g, '').toUpperCase();
					if (MAC === '') MAC = Math.random().toString(16).substring(2, 8);
					// remove PV info when phase not connected
					const showRe1 = sessy.status && sessy.status.renewable_energy_phase1 && sessy.status.renewable_energy_phase1.voltage_rms > 0;
					const showRe2 = sessy.status && sessy.status.renewable_energy_phase2 && sessy.status.renewable_energy_phase2.voltage_rms > 0;
					const showRe3 = sessy.status && sessy.status.renewable_energy_phase3 && sessy.status.renewable_energy_phase3.voltage_rms > 0;
					const showReTotal = showRe1 + showRe2 + showRe3 > 1;
					let correctCaps = capabilities;
					if (!showReTotal) correctCaps = correctCaps.filter((cap) => !cap.includes('measure_power.total'));
					if (!showRe1) correctCaps = correctCaps.filter((cap) => !cap.includes('p1'));
					if (!showRe2) correctCaps = correctCaps.filter((cap) => !cap.includes('p2'));
					if (!showRe3) correctCaps = correctCaps.filter((cap) => !cap.includes('p3'));
					// construct the homey device
					const device = {
						name: `SESSY_${sessy.ip}`,
						data: {
							id: MAC,
						},
						capabilities: correctCaps,
						settings: {
							host: sessy.ip,
							port: 80,
							mac,
							show_re_total: showReTotal,
							show_re1: showRe1,
							show_re2: showRe2,
							show_re3: showRe3,
						},
					};
					return Promise.resolve(device);
				});
				const devices = await Promise.all(allDevicesPromise);
				return Promise.resolve(devices);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});
	}

}

module.exports = SessyDriver;
