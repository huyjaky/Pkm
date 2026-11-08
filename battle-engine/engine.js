#!/usr/bin/env node
/**
 * PvP battle engine.
 *
 * A single long-lived process that hosts many Pokemon Showdown simulator battles and talks
 * to the Python server over newline-delimited JSON on stdin/stdout.
 *
 * Commands (stdin):
 *   {cmd:"create", id, format:"singles"|"doubles"|"multi", level:50|100|0, players:[{slot:"p1", name, team:[mon]}]}
 *   {cmd:"choose", id, slot, choice}        e.g. "move 1", "switch 3", "move 2 -1", "default"
 *   {cmd:"forfeit", id, slot}
 *   {cmd:"destroy", id}
 *   {cmd:"ping"}
 *
 * A `mon` is the decoded in-game Pokemon sent by the server:
 *   {speciesId, nickname, level, heldItemId, moveIds:[...], abilityNum, nature, ivs:{hp,atk,def,spa,spd,spe},
 *    evs:{...}, shiny, teraTypeId, friendship}
 *
 * Events (stdout):
 *   {evt:"ready"} | {evt:"pong"}
 *   {evt:"log", id, views:{p1:[lines], p2:[...], spectator:[...]}}
 *   {evt:"request", id, slot, request}
 *   {evt:"end", id, winner}
 *   {evt:"error", id, message}
 *   {evt:"teams", id, teams:{p1:[setSummary], ...}}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {Battle, Dex, toID} = require('pokemon-showdown');

const ASSETS_DIR = process.env.ASSETS_DIR || path.join(__dirname, '..', 'assets');

let META = {species: {}, moveConsts: {}, itemConsts: {}, types: {}};
try {
  META = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'meta.json'), 'utf8'));
} catch (e) {
  process.stderr.write(`[engine] meta.json not loaded (${e.message}); species/move ids must be names\n`);
}

const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

const FORMATS = {
  singles: {base: 'gen9customgame', gameType: 'singles', players: 2},
  doubles: {base: 'gen9doublescustomgame', gameType: 'doubles', players: 2},
  multi: {base: 'gen9doublescustomgame', gameType: 'multi', players: 4},
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------- id -> Showdown name helpers
function resolveSpecies(mon) {
  const entry = META.species[String(mon.speciesId)];
  const candidates = [];
  if (entry) {
    // e.g. CHARIZARD_MEGA_X -> charizardmegax, then progressively drop suffix tokens.
    const tokens = entry.const.split('_');
    for (let n = tokens.length; n > 0; n--) candidates.push(tokens.slice(0, n).join(''));
    candidates.push(entry.name);
  }
  if (mon.species) candidates.unshift(mon.species);
  for (const c of candidates) {
    const s = Dex.species.get(c);
    if (s.exists) return s;
  }
  return null;
}

function resolveMove(id) {
  const c = META.moveConsts[String(id)];
  const m = Dex.moves.get(c ? c : String(id));
  return m.exists ? m : null;
}

function resolveItem(id) {
  if (!id) return '';
  const c = META.itemConsts[String(id)];
  const it = Dex.items.get(c ? c : String(id));
  return it.exists ? it.name : '';
}

function resolveTera(id) {
  const t = META.types[String(id)];
  if (!t || t === 'NONE' || t === 'MYSTERY') return undefined;
  const ty = Dex.types.get(t);
  return ty.exists ? ty.name : undefined;
}

/** Convert one decoded in-game mon into a Showdown PokemonSet. Returns null if it can't battle. */
function toSet(mon, levelRule) {
  const species = resolveSpecies(mon);
  if (!species) return null;
  const moves = (mon.moveIds || []).map(resolveMove).filter(Boolean).map(m => m.name);
  if (!moves.length) moves.push('Struggle');
  const slot = ['0', '1', 'H'][mon.abilityNum] || '0';
  const ability = species.abilities[slot] || species.abilities['0'];
  const level = levelRule ? levelRule : Math.max(1, Math.min(100, mon.level || 50));
  const clamp = (v, max) => Math.max(0, Math.min(max, v | 0));
  const stat = (o, max, def) => ({
    hp: clamp(o?.hp ?? def, max), atk: clamp(o?.atk ?? def, max), def: clamp(o?.def ?? def, max),
    spa: clamp(o?.spa ?? def, max), spd: clamp(o?.spd ?? def, max), spe: clamp(o?.spe ?? def, max),
  });
  return {
    name: (mon.nickname || species.name).slice(0, 18),
    species: species.name,
    item: resolveItem(mon.heldItemId),
    ability,
    moves,
    nature: NATURES[mon.nature] || 'Serious',
    evs: stat(mon.evs, 255, 0),
    ivs: stat(mon.ivs, 31, 31),
    level,
    shiny: !!mon.shiny,
    happiness: mon.friendship ?? 255,
    teraType: resolveTera(mon.teraTypeId),
  };
}

// ---------------------------------------------------------------- battles
const battles = new Map();

function buildFormat(kind) {
  const def = FORMATS[kind];
  if (!def) throw new Error(`unknown format ${kind}`);
  const base = Dex.formats.get(def.base, true);
  // Shallow clone so we can change the game type (custom 2v2 "multi" with player-built teams).
  const fmt = Object.assign(Object.create(Object.getPrototypeOf(base)), base);
  fmt.gameType = def.gameType;
  fmt.playerCount = def.players;
  fmt.name = `[Gen 9] Hoenn Link ${kind}`;
  return fmt;
}

/** Split a Showdown update chunk into per-viewer logs, honouring |split|pN secret/public pairs. */
function splitViews(lines, slots) {
  const views = {spectator: []};
  for (const s of slots) views[s] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('|split|')) {
      const owner = line.slice(7);
      const secret = lines[i + 1];
      const pub = lines[i + 2];
      for (const s of slots) views[s].push(s === owner ? secret : pub);
      views.spectator.push(pub);
      i += 2;
      continue;
    }
    for (const k of Object.keys(views)) views[k].push(line);
  }
  return views;
}

function createBattle(msg) {
  const {id, format: kind, players} = msg;
  if (battles.has(id)) throw new Error('battle exists');
  const def = FORMATS[kind];
  if (!def) throw new Error(`unknown format ${kind}`);
  if (!Array.isArray(players) || players.length !== def.players) {
    throw new Error(`${kind} needs ${def.players} players`);
  }
  const levelRule = Number(msg.level) || 0;
  const slots = players.map(p => p.slot);
  const teams = {};
  const prepared = players.map(p => {
    const team = (p.team || []).map(m => toSet(m, levelRule)).filter(Boolean).slice(0, 6);
    if (!team.length) throw new Error(`${p.name} has no Pokemon that can battle`);
    teams[p.slot] = team.map(t => ({name: t.name, species: t.species, level: t.level, item: t.item,
      ability: t.ability, moves: t.moves, shiny: t.shiny}));
    return {...p, team};
  });

  const state = {slots, ended: false, battle: null};
  const battle = new Battle({
    format: buildFormat(kind),
    send: (type, data) => {
      const text = Array.isArray(data) ? data.join('\n') : data;
      if (type === 'update') {
        send({evt: 'log', id, views: splitViews(text.split('\n'), slots)});
      } else if (type === 'sideupdate') {
        const nl = text.indexOf('\n');
        const slot = text.slice(0, nl);
        const body = text.slice(nl + 1);
        if (body.startsWith('|request|')) {
          send({evt: 'request', id, slot, request: JSON.parse(body.slice(9))});
        } else if (body.startsWith('|error|')) {
          send({evt: 'error', id, slot, message: body.slice(7)});
        }
      } else if (type === 'end') {
        state.ended = true;
        let winner = '';
        try { winner = JSON.parse(text).winner || ''; } catch { /* ignore */ }
        send({evt: 'end', id, winner});
      }
    },
  });
  state.battle = battle;
  battles.set(id, state);
  send({evt: 'teams', id, teams});
  for (const p of prepared) battle.setPlayer(p.slot, {name: p.name, team: p.team});
  battle.sendUpdates();
}

function withBattle(id, fn) {
  const st = battles.get(id);
  if (!st) throw new Error('no such battle');
  return fn(st);
}

function handle(msg) {
  switch (msg.cmd) {
  case 'ping': send({evt: 'pong'}); break;
  case 'create': createBattle(msg); break;
  case 'choose':
    withBattle(msg.id, st => {
      if (st.ended) return;
      // On an invalid choice Showdown emits an |error| sideupdate explaining why.
      st.battle.choose(msg.slot, String(msg.choice));
      st.battle.sendUpdates();
    });
    break;
  case 'forfeit':
    withBattle(msg.id, st => {
      if (st.ended) return;
      st.battle.forceWin(otherSide(st, msg.slot));
      st.battle.sendUpdates();
    });
    break;
  case 'destroy':
    withBattle(msg.id, st => { st.battle.destroy(); battles.delete(msg.id); });
    break;
  default:
    throw new Error(`unknown cmd ${msg.cmd}`);
  }
}

function otherSide(st, slot) {
  // p1/p3 vs p2/p4
  const team = ['p1', 'p3'].includes(slot) ? 'p2' : 'p1';
  return st.slots.includes(team) ? team : null;
}

module.exports = {toSet, splitViews, buildFormat, resolveSpecies};

if (require.main === module) {
  const rl = readline.createInterface({input: process.stdin});
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
      handle(msg);
    } catch (e) {
      send({evt: 'error', id: msg && msg.id, message: String(e && e.message || e)});
    }
  });
  rl.on('close', () => process.exit(0));
  send({evt: 'ready'});
}
