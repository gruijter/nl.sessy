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
const SessyLocal = require('../../sessy_local');
const SessyCloud = require('../../sessy_cloud');

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

		if (this.homey.platform === 'cloud') this.log('Starting pair session on Homey cloud');
		else this.log('Starting pair session on Homey Pro');
		let discovered = [];

		session.setHandler('showView', async (viewId) => {
			// switch to Pro pairing view
			if (viewId === 'portal_login' && this.homey.platform !== 'cloud') await session.showView('portal_login_pro');
			if (viewId === 'done' && this.homey.platform !== 'cloud') this.log('done pairing');
		});

		session.setHandler('portal_login', async (conSett) => {
			try {
				this.log(conSett);
				const settings = conSett;
				const SESSY = new SessyCloud(settings);
				// check credentials and get all batteries
				const disc = await SESSY.discover();
				if (!disc || !disc[0]) throw Error((this.homey.__('pair.no_batteries_registered')));
				discovered = [];
				disc.forEach(async (sessy) => {
					const dev = sessy;
					dev.id = sessy.code;
					dev.name = sessy.fullName;
					dev.usernamePortal = settings.username_portal;
					dev.passwordPortal = settings.password_portal;
					// dev.fwDongle = sessy.version;
					// dev.fwBat = sessy.acBoardVersion;
					dev.useLocalConnection = this.homey.platform !== 'cloud';
					discovered.push(dev);
				});
				return Promise.all(discovered);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('auto_login', async () => {
			try {
				const SESSY = new SessyLocal();
				const disc = await SESSY.discover().catch(() => []);
				const discPromise = disc.map(async (sessy) => {
					const dev = { ...sessy };
					// try to find MAC
					const mac = await this.homey.arp.getMAC(sessy.ip).catch(() => '');
					let MAC = mac.replace(/:/g, '').toUpperCase();
					if (MAC === '') MAC = Math.random().toString(16).substring(2, 8);
					dev.name = `SESSY_${dev.ip}`;
					dev.id = MAC;
					dev.mac = mac;
					dev.useLocalConnection = true;
					return dev;
				});
				discovered = await Promise.all(discPromise);
				return Promise.all(discovered);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('manual_login', async (conSett) => {
			try {
				this.log(conSett);
				const settings = conSett;
				const SESSY = new SessyLocal(settings);
				const dev = conSett;
				// check credentials and get status info
				const status = await SESSY.getStatus();
				dev.status = status;
				// try to find the MAC
				const mac = await this.homey.arp.getMAC(settings.host).catch(() => '');
				let MAC = mac.replace(/:/g, '').toUpperCase();
				if (MAC === '') MAC = Math.random().toString(16).substring(2, 8);
				dev.name = `SESSY_${settings.host}`;
				dev.id = MAC;
				dev.ip = settings.host;
				dev.mac = MAC;
				dev.useLocalConnection = true;
				dev.sn_dongle = settings.username;
				dev.password_dongle = settings.password;
				dev.force_control_strategy = true;
				// get fwLevel
				// const OTAstatus = await SESSY.getOTAStatus();
				// dev.fwDongle = OTAstatus.self.installed_firmware.version;
				// dev.fwBat = OTAstatus.serial.installed_firmware.version;
				discovered = [dev];
				return Promise.resolve(discovered);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});

		session.setHandler('list_devices', async () => {
			try {
				const allDevicesPromise = [];
				discovered.forEach(async (sessy) => {
					// remove PV info when phase not connected
					const showRe1 = sessy.status && sessy.status.renewable_energy_phase1 && (sessy.status.renewable_energy_phase1.voltage_rms > 0);
					const showRe2 = sessy.status && sessy.status.renewable_energy_phase2 && (sessy.status.renewable_energy_phase2.voltage_rms > 0);
					const showRe3 = sessy.status && sessy.status.renewable_energy_phase3 && (sessy.status.renewable_energy_phase3.voltage_rms > 0);
					const showReTotal = showRe1 + showRe2 + showRe3 > 1;
					let correctCaps = capabilities;
					if (!showReTotal) correctCaps = correctCaps.filter((cap) => !cap.includes('measure_power.total'));
					if (!showRe1) correctCaps = correctCaps.filter((cap) => !cap.includes('p1'));
					if (!showRe2) correctCaps = correctCaps.filter((cap) => !cap.includes('p2'));
					if (!showRe3) correctCaps = correctCaps.filter((cap) => !cap.includes('p3'));
					// construct the homey device
					const device = {
						name: sessy.name,
						data: {
							id: sessy.id,
						},
						capabilities: correctCaps,
						settings: {
							id: sessy.id,
							mac: sessy.mac,
							fwDongle: sessy.fwDongle,
							fwBat: sessy.fwBat,
							username_portal: sessy.usernamePortal,
							password_portal: sessy.passwordPortal,
							use_local_connection: sessy.useLocalConnection,
							sn_dongle: sessy.sn_dongle,
							password_dongle: sessy.password_dongle,
							force_control_strategy: sessy.force_control_strategy,
							host: sessy.ip,
							port: sessy.port || 80,
							show_re_total: showReTotal,
							show_re1: showRe1,
							show_re2: showRe2,
							show_re3: showRe3,
						},
					};
					allDevicesPromise.push(device);
				});
				const devices = await Promise.all(allDevicesPromise);
				// console.dir(devices, { depth: null });
				return Promise.resolve(devices);
			} catch (error) {
				this.error(error);
				return Promise.reject(error);
			}
		});
	}

}

module.exports = SessyDriver;
