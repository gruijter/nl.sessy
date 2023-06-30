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

const http = require('http');
const os = require('os');
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

// P1
const getP1StatusEP = '/api/v1/p1/status';
// const getP1StatusEP = '/api/v1/p1/details';
// OTA
const getOTACheckEP = '/api/v1/ota/check';
const getOTAStatusEP = '/api/v1/ota/status';
// SESSY
const getStatusEP = '/api/v1/power/status';
const getStrategyEP = '/api/v1/power/active_strategy';
const setStrategyEP = '/api/v1/power/active_strategy';
const setSetpointEP = '/api/v1/power/setpoint';

const defaultPort = 80;
const defaultTimeout = 15000;

// Represents a session to the local Sessy API.
class Sessy {
	constructor(opts) {
		const options = opts || {};
		this.username = options.username;
		this.password = options.password;
		this.host = options.host;
		this.port = options.port || defaultPort;
		this.timeout = options.timeout || defaultTimeout;
		this.lastResponse = undefined;
	}

	async login(opts) {
		try {
			const options = opts || {};
			const host = options.host || this.host;
			const port = options.port || this.port;
			const username = options.username || this.username;
			const password = options.password || this.password;
			const timeout = options.timeout || this.timeout;
			this.host = host;
			this.port = port;
			this.username = username;
			this.password = password;
			this.timeout = timeout;
			const status = await this.getStatus(options);
			return Promise.resolve(status);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getStatus(opts) {
		try {
			const options = opts || {};
			const data = '';
			const statusEP = options.p1 ? getP1StatusEP : getStatusEP;
			const res = await this._makeRequest(statusEP, data);
			this.status = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getOTAStatus() {
		try {
			const data = '';
			await this._makeRequest(getOTACheckEP, data); // check for updates
			await setTimeoutPromise(4000); // wait 4 seconds to perform check
			let res = await this._makeRequest(getOTAStatusEP, data);
			if (JSON.stringify(res).includes('CHECKING')) {
				await setTimeoutPromise(6000); // wait another 6 seconds to perform check
				res = await this._makeRequest(getOTAStatusEP, data);
			}
			this.OTAstatus = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async getStrategy() {
		try {
			const data = '';
			const res = await this._makeRequest(getStrategyEP, data);
			this.strategy = res;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// [ POWER_STRATEGY_NOM, POWER_STRATEGY_ROI, POWER_STRATEGY_API, POWER_STRATEGY_IDLE ]
	async setStrategy(opts) {
		try {
			const options = opts || {};
			const data = { strategy: options.strategy };
			const res = await this._makeRequest(setStrategyEP, data);
			this.strategy = options.strategy;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async setSetpoint(opts) {
		try {
			const options = opts || {};
			const data = { setpoint: options.setpoint };
			const res = await this._makeRequest(setSetpointEP, data);
			this.strategy = options.strategy;
			return Promise.resolve(res);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async discover(opts) {
		try {
			const hostsToTest = [];	// make an array of all host IP's in the LAN
			const servers = [];
			// const servers = dns.getServers() || [];	// get the IP address of all routers in the LAN
			const ifaces = os.networkInterfaces();	// get ip address info from all network interfaces
			Object.keys(ifaces).forEach((ifName) => {
				ifaces[ifName].forEach((iface) => {
					if (iface.family === 'IPv4' && !iface.internal) {
						servers.push(iface.address);
					}
				});
			});
			servers.forEach((server) => {	// make an array of all host IP's in the LAN
				const splitServer = server.split('.').slice(0, 3);
				const reducer = (accumulator, currentValue) => `${accumulator}.${currentValue}`;
				const segment = splitServer.reduce(reducer);
				if (segment.slice(0, 3) === '127') { return undefined; }
				for (let host = 1; host <= 254; host += 1) {
					const ipToTest = `${segment}.${host}`;
					hostsToTest.push(ipToTest);
				}
				return true;
			});

			// try all servers for login response, with http timeout 4 seconds
			const discoveryEP = (opts && opts.p1) ? getP1StatusEP : getStatusEP;
			const allHostsPromise = hostsToTest.map(async (hostToTest) => {
				let found = false;
				const status = await this._makeRequest(discoveryEP, undefined, 4000, hostToTest).catch(() => undefined);
				if (status) found = { ip: hostToTest, status }; // device found
				return Promise.resolve(found);
			});
			const allHosts = await Promise.all(allHostsPromise);
			const discoveredHosts = allHosts
				.filter((host) => host)
				.filter((value, index, self) => index === self.findIndex((h) => h.ip === value.ip)); // remove double found IP's

			if (!discoveredHosts[0]) throw Error('No device discovered. Please provide host ip manually');
			return Promise.resolve(discoveredHosts);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(actionPath, data, timeout, host) {
		try {
			const postData = JSON.stringify(data);
			const headers = {
				'Content-Type': 'application/json;charset=utf-8',
			};
			if (this.client) headers.Client = this.client;
			const options = {
				hostname: host || this.host,
				port: this.port,
				path: actionPath,
				auth: `${this.username}:${this.password}`,
				headers,
				method: 'GET',
			};
			if (data && data !== '') options.method = 'POST';
			// console.log(options);
			const result = await this._makeHttpRequest(options, postData, timeout);
			this.lastResponse = result.body || result.statusCode;
			const contentType = result.headers['content-type'];
			// find errors
			if (result.statusCode === 500) {
				throw Error(`Request Failed: ${result.body}`);
			}
			if (result.statusCode === 401) {
				throw Error('Wrong username/password');
			}
			if (result.statusCode !== 200) {
				this.lastResponse = result.statusCode;
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
			}
			if (!/application\/json/.test(contentType)) {
				throw Error(`Expected json but received ${contentType}: ${result.body}`);
			}
			const json = JSON.parse(result.body);
			if (!json.status || json.status !== 'ok') throw Error(`Request not ok: ${result.body}`);
			// console.dir(json, { depth: null });
			return Promise.resolve(json);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	_makeHttpRequest(options, postData, timeout) {
		return new Promise((resolve, reject) => {
			const opts = options;
			opts.timeout = timeout || this.timeout;
			const req = http.request(opts, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					this.lastResponse = resBody;
					if (!res.complete) {
						return reject(Error('The connection was terminated while the message was still being sent'));
					}
					res.body = resBody;
					return resolve(res);
				});
			});
			req.on('error', (e) => {
				req.destroy();
				this.lastResponse = e;
				return reject(e);
			});
			req.on('timeout', () => {
				req.destroy();
			});
			req.end(postData);
		});
	}

}

module.exports = Sessy;

// START TEST HERE
// const test = async () => {
// 	const SESSY = new Sessy();
// 	const discovered = await SESSY.discover({ p1: true });
// 	const SESSY = new Sessy({ username: '.....', password: '.....', host: '10.0.0.10' });
// 	const discovered = await SESSY.discover();
// 	console.dir(discovered, { depth: null });
// 	const status = await SESSY.getStatus();
// 	console.dir(status, { depth: null });
// 	const setStrategy = await SESSY.setStrategy({ strategy: 'POWER_STRATEGY_API' });
// 	console.dir(setStrategy, { depth: null });
// 	const strategy = await SESSY.getStrategy();
// 	console.dir(strategy, { depth: null });
// 	const setSetpoint = await SESSY.setSetpoint({ setpoint: 500 });
// 	console.dir(setSetpoint, { depth: null });
// 	const status2 = await SESSY.getStatus();
// 	console.dir(status2, { depth: null });
// 	const OTAstatus = await SESSY.getOTAStatus();
// 	console.dir(OTAstatus, { depth: null });
// };

// test();

/*
Status response:
{
  status: 'ok',
  sessy: {
    state_of_charge: 0.38999998569488525,
    power: -1932,
    power_setpoint: -2200,
    system_state: 'SYSTEM_STATE_RUNNING_SAFE'
  },
  renewable_energy_phase1: { voltage_rms: 234591, current_rms: 1000, power: 234 },
  renewable_energy_phase2: { voltage_rms: 0, current_rms: 0, power: 0 },
  renewable_energy_phase3: { voltage_rms: 0, current_rms: 0, power: 0 }
}
{
  status: 'ok',
  sessy: {
    state_of_charge: 0.38999998569488525,
    power: -1932,
    power_setpoint: -2200,
    system_state: 'SYSTEM_STATE_RUNNING_SAFE'
  },
  renewable_energy_phase1: { voltage_rms: 234591, current_rms: 1000, power: 234 },
  renewable_energy_phase2: { voltage_rms: 0, current_rms: 0, power: 0 },
  renewable_energy_phase3: { voltage_rms: 0, current_rms: 0, power: 0 }
}

Strategy response:
{ status: 'ok', strategy: 'POWER_STRATEGY_API' }

Discover response:
[
  {
    ip: '10.0.0.80',
    res: {
      status: 'ok',
      sessy: {
        state_of_charge: 1,
        power: 0,
        power_setpoint: 0,
        system_state: 'SYSTEM_STATE_STANDBY'
      },
      renewable_energy_phase1: { voltage_rms: 237499, current_rms: 0, power: 0 },
      renewable_energy_phase2: { voltage_rms: 0, current_rms: 0, power: 0 },
      renewable_energy_phase3: { voltage_rms: 0, current_rms: 0, power: 0 }
    }
  }
]

P1 discover response:
[
  {
    ip: '10.0.0.82',
    status: { status: 'ok', state: 'P1_OK', net_power_delivered: 0 }
  }
]

GET /v1/ota/check:
{
	"status":	"ok"
}

GET /api/v1/ota/status:
{
	"status":	"ok",
	"self":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	""
		},
		"state":	"OTA_INACTIVE",
		"update_progress":	0
	},
	"serial":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	""
		},
		"state":	"OTA_INACTIVE",
		"update_progress":	0
	}
}
during check:
{
	"status":	"ok",
	"self":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	""
		},
		"state":	"OTA_CHECKING",
		"update_progress":	0
	},
	"serial":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	""
		},
		"state":	"OTA_INACTIVE",
		"update_progress":	0
	}
}
after check:
{
	"status":	"ok",
	"self":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	"1.1.2"
		},
		"state":	"OTA_UP_TO_DATE",
		"update_progress":	0
	},
	"serial":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	"1.1.2"
		},
		"state":	"OTA_UP_TO_DATE",
		"update_progress":	0
	}
}

During update:
{
	"status":	"ok",
	"self":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	"1.1.2"
		},
		"state":	"OTA_UPDATING",
		"update_progress":	0.769141137599945
	},
	"serial":	{
		"installed_firmware":	{
			"version":	"1.1.2"
		},
		"available_firmware":	{
			"version":	"1.1.2"
		},
		"state":	"OTA_DONE",
		"update_progress":	0
	}
}

POST /api/v1/ota/start   PAYLOAD SESSY: { target:'OTA_TARGET_SERIAL } PAYLOAD P1DONGLE: {"target":"OTA_TARGET_SELF"}
{
	"status":	"ok"
}

/api/v1/network/status
{
	"status":	"ok",
	"network_status":	["unknown", "WIFI_STA_IS_ENABLED", "WIFI_STA_IS_STARTED", "WIFI_STA_IS_CONNECTED", "WIFI_STA_HAS_CLIENT_IP"],
	"wifi_sta":	{
		"ip":	[10, 10, 10, 10],
		"rssi":	-55,
		"ssid":	"abcdef"
	},
	"eth":	{
		"ip":	[0, 0, 0, 0]
	}
}

/v1/system/settings
{
	"status":	"ok",
	"p1_hostname":	"10.10.10.11",
	"pv_hostname":	"10.10.10.10",
	"group_current":	16,
	"phase_current":	25,
	"group_sessys":	1,
	"phase_sessys":	1,
	"total_sessys":	1,
	"active_phase":	1,
	"min_power":	50,
	"max_power":	2200,
	"enabled_time":	"00:00-23:59"
}

/api/v1/p1/status
{
	"status":	"ok",
	"state":	"P1_OK",
	"net_power_delivered":	0
}

/api/v1/p1/details
{
	"status":	"ok",
	"state":	"P1_OK",
	"total_power":	0,
	"power_consumed":	0,
	"power_produced":	0,
	"voltage_l1":	0,
	"voltage_l2":	0,
	"voltage_l3":	0
}
*/
