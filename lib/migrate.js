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

const setTimeoutPromise = (delay) => new Promise((resolve) => {
  // eslint-disable-next-line homey-app/global-timers
  setTimeout(resolve, delay);
});

async function migrateCapabilities(device, correctCaps) {
  device.log(`checking device migration for ${device.getName()}`);

  // store the capability states before migration
  const sym = Object.getOwnPropertySymbols(device).find((s) => String(s) === 'Symbol(state)');
  const state = device[sym];

  for (let index = 0; index <= correctCaps.length; index += 1) {
    const caps = await device.getCapabilities();
    const newCap = correctCaps[index];
    if (caps[index] !== newCap) {
      device.setUnavailable(device.homey.__('sessy.migrating')).catch(() => null);
      // remove all caps from here
      for (let i = index; i < caps.length; i += 1) {
        device.log(`removing capability ${caps[i]} for ${device.getName()}`);
        await device.removeCapability(caps[i])
          .catch((error) => device.log(error));
        await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
      }
      // add the new cap
      if (newCap !== undefined) {
        device.log(`adding capability ${newCap} for ${device.getName()}`);
        await device.addCapability(newCap);
        // restore capability state
        if (state && state[newCap]) device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
        // else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
        if (state && state[newCap] !== undefined) await device.setCapability(newCap, state[newCap]).catch((e) => device.error(e));
        await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
      }
    }
  }
}

module.exports = { migrateCapabilities };
