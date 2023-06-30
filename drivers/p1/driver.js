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
	'measure_power',
	'system_state',
];

class P1Driver extends Driver {

	async onInit() {
		this.ds = { capabilities };
		this.log('P1 driver has been initialized');
	}

	async onPair(session) {

		session.setHandler('list_devices', async () => {
			try {
				const SESSY = new Sessy();
				const discovered = await SESSY.discover({ p1: true }).catch(() => []);
				const allDevicesPromise = discovered.map(async (p1) => {
					// try to find the MAC
					const mac = await this.homey.arp.getMAC(p1.ip).catch(() => '');
					let MAC = mac.replace(/:/g, '').toUpperCase();
					if (MAC === '') MAC = Math.random().toString(16).substring(2, 8);
					// construct the homey device
					const device = {
						name: `SESSY P1_${p1.ip}`,
						data: {
							id: MAC,
						},
						capabilities,
						settings: {
							host: p1.ip,
							port: 80,
							mac,
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

module.exports = P1Driver;
