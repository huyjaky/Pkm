#ifndef GUARD_ONLINE_LINK_H
#define GUARD_ONLINE_LINK_H

// Hoenn Link: a virtual link cable for real in-ROM link battles over the internet.
//
// The ROM's own link protocol (link.c: block transfers, standby, close, link player exchange) is kept
// unchanged. Only the per-frame serial exchange (LinkMain1) is replaced: the command this GBA would
// shift out goes into gVLink.out, and the commands of every player (including our own, as on real
// SIO multiplayer hardware) are read from gVLink.in. The web client relays the queues between players.

#include "link.h"

#define VLINK_MAGIC        0x4B4E4C56 // "VLNK"
#define VLINK_QUEUE        64         // commands per queue (power of two)

enum VLinkState
{
    VLINK_STATE_IDLE,
    VLINK_STATE_WAITING,   // start requested, waiting for the player to be free in the overworld
    VLINK_STATE_IN_BATTLE,
    VLINK_STATE_DONE,      // battle over, outcome written
};

enum VLinkBattleKind
{
    VLINK_SINGLE,
    VLINK_DOUBLE,
    VLINK_MULTI,
};

struct VLinkCmd
{
    u16 data[CMD_LENGTH];
};

struct VLinkMailbox
{
    /*0x00*/ u32 magic;          // web: VLINK_MAGIC while a session is assigned
    /*0x04*/ u8 active;          // web
    /*0x05*/ u8 multiplayerId;   // web: 0 = link master
    /*0x06*/ u8 playerCount;     // web
    /*0x07*/ u8 battleKind;      // web: enum VLinkBattleKind
    /*0x08*/ u8 startRequest;    // web sets 1, ROM clears when the battle starts
    /*0x09*/ u8 state;           // ROM: enum VLinkState
    /*0x0A*/ u8 outcome;         // ROM: gBattleOutcome once state == DONE
    /*0x0B*/ u8 linkOpen;        // ROM
    /*0x0C*/ u16 outHead;        // ROM writes out[outHead % Q], then increments
    /*0x0E*/ u16 outTail;        // web reads, then increments
    /*0x10*/ u16 inHead[MAX_LINK_PLAYERS]; // web writes in[p][inHead % Q], then increments (ROM for its own id)
    /*0x18*/ u16 inTail[MAX_LINK_PLAYERS]; // ROM consumes
    /*0x20*/ u16 overflow;       // ROM: commands dropped because a queue was full (should stay 0)
    /*0x22*/ u16 forfeit;        // web: 1 = this player gives up (AFK); ROM ends the battle as a loss
    /*0x24*/ struct VLinkCmd out[VLINK_QUEUE];
             struct VLinkCmd in[MAX_LINK_PLAYERS][VLINK_QUEUE];
};

extern struct VLinkMailbox gVLink;

bool32 VLink_IsActive(void);
bool32 VLink_IsOpen(void);
void VLink_OnOpenLink(void);
void VLink_OnCloseLink(void);
u32 VLink_Main1(u16 *sendCmd, u16 (*recvCmds)[CMD_LENGTH]);
void VLink_Update(void);

#endif // GUARD_ONLINE_LINK_H
