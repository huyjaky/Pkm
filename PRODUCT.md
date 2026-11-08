# Hoenn Link — Product

## What it is
A private web client for playing a self-built pokeemerald-expansion ROM together with a small group of friends.
Each player runs their own game in the browser (mGBA compiled to WebAssembly); the site adds a shared layer on top:
live positions on a Hoenn minimap, chat, and PvP battles (1v1 singles/doubles, 2v2 team rooms) using the teams
read straight from each player's game.

## Users
A handful of friends (Vietnamese speakers) playing at the same time, mostly on desktop, sometimes phone.
They know Pokémon well; they do not want setup steps or explanations.

## Surface and mode
- Main app (game + side panels + battle screen): **Operate**. The game canvas is the work; panels are quiet, scannable, keyboard-friendly.
- Login screen: Operate with a small amount of character (it is the only "front door").

## Principles
1. The game is the centre of the screen at integer scale; nothing overlaps it except deliberate overlays (battle, challenges).
2. Social state is glanceable: who is online, where they are, who is in a battle.
3. No constraints on play: story, roaming, battling are all optional; nothing forces a player out of their game.
4. Cloud save is automatic and its state is always visible.

## Look (chosen by the owner)
"Modern console": graphite ground (#18191b / #222427), ink #eff0f1, single orange accent #ff4a1f; Sora for headings,
Figtree for text, Martian Mono for numbers and coordinates. Dark first.

## Deploy
Docker; served on the owner's domain behind Caddy with automatic HTTPS (required for SharedArrayBuffer / threads).
