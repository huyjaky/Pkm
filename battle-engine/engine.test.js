'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {toSet, splitViews} = require('./engine');

const mon = (speciesId, moveIds, extra = {}) => ({speciesId, level: 30, moveIds, abilityNum: 0, nature: 3,
  ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}, evs: {}, heldItemId: 0, ...extra});

test('toSet maps ids through meta.json', () => {
  const s = toSet(mon(6, [52, 53], {heldItemId: 472, abilityNum: 2}), 50); // Charizard, Ember/Flamethrower, Leftovers
  assert.equal(s.species, 'Charizard');
  assert.deepEqual(s.moves, ['Ember', 'Flamethrower']);
  assert.equal(s.item, 'Leftovers');
  assert.equal(s.ability, 'Solar Power');
  assert.equal(s.level, 50);
  assert.equal(s.nature, 'Adamant');
});

test('toSet resolves mega form constants', () => {
  assert.equal(toSet(mon(907, [1]), 0).species, 'Charizard-Mega-X');
});

test('splitViews hides secret lines from other sides', () => {
  const v = splitViews(['|turn|1', '|split|p1', '|-damage|p1a: X|50/100', '|-damage|p1a: X|50/100%'], ['p1', 'p2']);
  assert.deepEqual(v.p1, ['|turn|1', '|-damage|p1a: X|50/100']);
  assert.deepEqual(v.p2, ['|turn|1', '|-damage|p1a: X|50/100%']);
  assert.deepEqual(v.spectator, v.p2);
});

function runEngine(cmds, untilEvt) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'engine.js')], {env: process.env});
    const events = [];
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout ' + JSON.stringify(events.slice(-3)))); }, 15000);
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        events.push(ev);
        cmds.onEvent?.(ev, c => p.stdin.write(JSON.stringify(c) + '\n'));
        if (untilEvt(ev)) { clearTimeout(timer); p.kill(); resolve(events); }
      }
    });
    p.stderr.on('data', d => process.stderr.write(d));
    for (const c of cmds.initial) p.stdin.write(JSON.stringify(c) + '\n');
  });
}

test('singles battle runs to completion with forfeit', async () => {
  const team = [mon(25, [85]), mon(1, [33])];
  const events = await runEngine({
    initial: [{cmd: 'create', id: 'b1', format: 'singles', level: 50, players: [
      {slot: 'p1', name: 'Ash', team}, {slot: 'p2', name: 'Gary', team}]}],
    onEvent: (ev, write) => {
      if (ev.evt === 'request' && ev.request.teamPreview) write({cmd: 'choose', id: 'b1', slot: ev.slot, choice: 'default'});
      if (ev.evt === 'request' && ev.request.active && ev.slot === 'p1') write({cmd: 'choose', id: 'b1', slot: 'p1', choice: 'move 1'});
      if (ev.evt === 'request' && ev.request.active && ev.slot === 'p2') write({cmd: 'choose', id: 'b1', slot: 'p2', choice: 'move 1'});
      if (ev.evt === 'log' && ev.views.spectator.some(l => l === '|turn|3')) write({cmd: 'forfeit', id: 'b1', slot: 'p2'});
    },
  }, ev => ev.evt === 'end' || (ev.evt === 'error' && ev.id === 'b1' && !ev.slot));
  const end = events.find(e => e.evt === 'end');
  assert.ok(end, JSON.stringify(events.filter(e => e.evt === 'error')));
  assert.equal(end.winner, 'Ash');
});

test('2v2 multi battle starts with four players', async () => {
  const team = [mon(25, [85])];
  const players = ['p1', 'p2', 'p3', 'p4'].map((slot, i) => ({slot, name: 'P' + i, team}));
  const events = await runEngine({initial: [{cmd: 'create', id: 'm1', format: 'multi', level: 50, players}]},
    ev => ev.evt === 'request' && ev.slot === 'p4' || ev.evt === 'error');
  assert.ok(!events.some(e => e.evt === 'error'), JSON.stringify(events.find(e => e.evt === 'error')));
  const reqSlots = new Set(events.filter(e => e.evt === 'request').map(e => e.slot));
  assert.ok(reqSlots.has('p4'));
});
