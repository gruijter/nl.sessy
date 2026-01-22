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

const { Driver } = require('homey');

const capabilities = [
  'measure_power',
  'meter_power',
  'measure_frequency',

  'measure_power.p1',
  'measure_voltage.p1',
  'measure_current.p1',
  'meter_power.p1Import',
  'meter_power.p1Export',

  'measure_power.p2',
  'measure_voltage.p2',
  'measure_current.p2',
  'meter_power.p2Import',
  'meter_power.p2Export',

  'measure_power.p3',
  'measure_current.p3',
  'measure_voltage.p3',
  'meter_power.p3Import',
  'meter_power.p3Export',
];

class PVDriver extends Driver {

  async onInit() {
    this.ds = { capabilities };
    this.log('PV driver has been initialized');
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      try {
        this.log('Pairing of PV system started');
        const sessyDriver = this.homey.drivers.getDriver('sessy');
        await sessyDriver.ready(() => null);
        const sessys = await sessyDriver.getDevices();
        if (!sessys) throw Error('Cannot find a Sessy device in Homey. Sessy needs to be added first!');
        const allDevicesPromise = [];
        sessys.forEach((sessy) => {
          // console.log(sessy.getName(), sessy.lastStatus, sessy.lastEnergy);
          // remove PV info when phase not connected
          const showRe1 = sessy.lastStatus && sessy.lastStatus.renewable_energy_phase1 && (sessy.lastStatus.renewable_energy_phase1.voltage_rms > 0);
          const showRe2 = sessy.lastStatus && sessy.lastStatus.renewable_energy_phase2 && (sessy.lastStatus.renewable_energy_phase2.voltage_rms > 0);
          const showRe3 = sessy.lastStatus && sessy.lastStatus.renewable_energy_phase3 && (sessy.lastStatus.renewable_energy_phase3.voltage_rms > 0);
          const onlyShowTotalPower = [showRe1, showRe2, showRe3].filter(Boolean).length < 2;
          const PVPresent = showRe1 || showRe2 || showRe3;
          if (PVPresent) {
            let correctCaps = capabilities;
            if (!showRe1) correctCaps = correctCaps.filter((cap) => !cap.includes('p1'));
            if (!showRe2) correctCaps = correctCaps.filter((cap) => !cap.includes('p2'));
            if (!showRe3) correctCaps = correctCaps.filter((cap) => !cap.includes('p3'));
            if (onlyShowTotalPower) correctCaps = correctCaps.filter((cap) => !cap.includes('measure_power.p'));
            // construct the homey device
            const device = {
              name: `PV_${sessy.getName()}`,
              data: {
                id: sessy.getData().id,
              },
              capabilities: correctCaps,
              settings: {
                sn_sessy: sessy.getSettings().sn_sessy,
                sn_dongle: sessy.getSettings().sn_dongle,
                show_re1: showRe1,
                show_re2: showRe2,
                show_re3: showRe3,
              },
            };
            allDevicesPromise.push(device);
          }
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

module.exports = PVDriver;
