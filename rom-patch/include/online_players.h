#ifndef GUARD_ONLINE_PLAYERS_H
#define GUARD_ONLINE_PLAYERS_H

// Hoenn Link: shows other online players walking in the overworld.
//
// The web client (outside the ROM) writes friends' positions into gOnlinePlayers through
// emulator memory, and reads this player's own state from gOnlineSelf. The ROM never talks
// to the network itself.

#define ONLINE_PLAYERS_MAX            8
#define ONLINE_PLAYERS_MAGIC          0x4C4E4F48 // "HONL"
#define LOCALID_ONLINE_PLAYER_START   228        // 228..235, below the Berry Blender link IDs
#define IS_LOCALID_ONLINE_PLAYER(id)  ((id) >= LOCALID_ONLINE_PLAYER_START && (id) < LOCALID_ONLINE_PLAYER_START + ONLINE_PLAYERS_MAX)

// Written by the web client. 12 bytes each.
struct OnlinePlayer
{
    /*0x00*/ u8 active;
    /*0x01*/ s8 mapGroup;
    /*0x02*/ s8 mapNum;
    /*0x03*/ u8 facing;      // DIR_SOUTH..DIR_EAST
    /*0x04*/ s16 x;          // map coordinates, without MAP_OFFSET
    /*0x06*/ s16 y;
    /*0x08*/ u16 graphicsId; // object event graphics (walking, biking, surfing...)
    /*0x0A*/ u8 elevation;
    /*0x0B*/ u8 padding;
};

// Written by the ROM every overworld frame. 20 bytes.
struct OnlineSelf
{
    /*0x00*/ u32 magic;
    /*0x04*/ u32 frame;
    /*0x08*/ s8 mapGroup;
    /*0x09*/ s8 mapNum;
    /*0x0A*/ u8 facing;
    /*0x0B*/ u8 elevation;
    /*0x0C*/ s16 x;
    /*0x0E*/ s16 y;
    /*0x10*/ u16 graphicsId;
    /*0x12*/ u16 padding;
};

extern struct OnlinePlayer gOnlinePlayers[ONLINE_PLAYERS_MAX];
extern u32 gOnlinePlayersMagic;
extern struct OnlineSelf gOnlineSelf;

void OnlinePlayers_Update(void);

#endif // GUARD_ONLINE_PLAYERS_H
