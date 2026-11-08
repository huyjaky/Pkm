#include "global.h"
#include "battle.h"
#include "battle_main.h"
#include "battle_setup.h"
#include "battle_util2.h"
#include "event_data.h"
#include "link.h"
#include "load_save.h"
#include "main.h"
#include "online_link.h"
#include "overworld.h"
#include "palette.h"
#include "pokemon.h"
#include "script.h"
#include "constants/battle.h"
#include "constants/cable_club.h"
#include "constants/songs.h"
#include "constants/trainers.h"

// See include/online_link.h.
EWRAM_DATA struct VLinkMailbox gVLink = {0};

extern u8 gLastRecvQueueCount;

static void CB2_ReturnFromVLinkBattle(void);

bool32 VLink_IsActive(void)
{
    return gVLink.magic == VLINK_MAGIC && gVLink.active
        && gVLink.playerCount >= 2 && gVLink.playerCount <= MAX_LINK_PLAYERS
        && gVLink.multiplayerId < gVLink.playerCount;
}

bool32 VLink_IsOpen(void)
{
    return gVLink.linkOpen && VLink_IsActive();
}

void VLink_OnOpenLink(void)
{
    if (VLink_IsActive())
        gVLink.linkOpen = TRUE;
}

void VLink_OnCloseLink(void)
{
    gVLink.linkOpen = FALSE;
}

static inline bool32 QueueHasRoom(u16 head, u16 tail)
{
    return (u16)(head - tail) < VLINK_QUEUE;
}

// Replacement for the serial exchange in LinkMain1 while the virtual link is open.
u32 VLink_Main1(u16 *sendCmd, u16 (*recvCmds)[CMD_LENGTH])
{
    u32 i, j;
    u32 self = gVLink.multiplayerId;
    u32 status;
    u32 pending = 0;
    bool32 receivedAny = FALSE;

    if (sendCmd[0] != LINKCMD_NONE)
    {
        if (QueueHasRoom(gVLink.outHead, gVLink.outTail) && QueueHasRoom(gVLink.inHead[self], gVLink.inTail[self]))
        {
            struct VLinkCmd *out = &gVLink.out[gVLink.outHead % VLINK_QUEUE];
            struct VLinkCmd *loop = &gVLink.in[self][gVLink.inHead[self] % VLINK_QUEUE];
            for (j = 0; j < CMD_LENGTH; j++)
                out->data[j] = loop->data[j] = sendCmd[j];
            gVLink.outHead++;
            // Like SIO multiplayer hardware, every player also receives its own command.
            gVLink.inHead[self]++;
        }
        else
        {
            gVLink.overflow++;
        }
    }

    for (i = 0; i < MAX_LINK_PLAYERS; i++)
    {
        if (i < gVLink.playerCount && gVLink.inHead[i] != gVLink.inTail[i])
        {
            struct VLinkCmd *cmd = &gVLink.in[i][gVLink.inTail[i] % VLINK_QUEUE];
            for (j = 0; j < CMD_LENGTH; j++)
                recvCmds[i][j] = cmd->data[j];
            gVLink.inTail[i]++;
            receivedAny = TRUE;
            pending += (u16)(gVLink.inHead[i] - gVLink.inTail[i]);
        }
        else
        {
            for (j = 0; j < CMD_LENGTH; j++)
                recvCmds[i][j] = LINKCMD_NONE;
        }
    }
    // link.c waits for an empty receive queue before standby/close. On hardware the queue drains every
    // frame; over the network commands arrive in bursts and the backlog may never reach zero, which would
    // freeze the end of the battle. Order is preserved by our queues, so report it as drained.
    (void)pending;
    gLastRecvQueueCount = 0;

    status = LINK_STAT_CONN_ESTABLISHED
           | (gVLink.playerCount << LINK_STAT_PLAYER_COUNT_SHIFT)
           | (self & LINK_STAT_LOCAL_ID);
    if (self == 0)
        status |= LINK_STAT_MASTER;
    if (!receivedAny)
        status |= LINK_STAT_RECEIVED_NOTHING;
    return status;
}

static bool32 CanStartBattleNow(void)
{
    return gMain.callback2 == CB2_Overworld
        && !ArePlayerFieldControlsLocked()
        && !gPaletteFade.active;
}

static void StartVLinkBattle(void)
{
    gVLink.startRequest = FALSE;
    gVLink.state = VLINK_STATE_IN_BATTLE;
    gVLink.outcome = 0;

    // The party is restored after the battle: link battles never change your real team.
    SavePlayerParty();
    gLinkType = LINKTYPE_BATTLE;
    switch (gVLink.battleKind)
    {
    case VLINK_DOUBLE:
        gSpecialVar_0x8004 = USING_DOUBLE_BATTLE;
        gBattleTypeFlags = BATTLE_TYPE_DOUBLE | BATTLE_TYPE_LINK | BATTLE_TYPE_TRAINER;
        break;
    case VLINK_MULTI:
        gSpecialVar_0x8004 = USING_MULTI_BATTLE;
        gBattleTypeFlags = BATTLE_TYPE_DOUBLE | BATTLE_TYPE_LINK | BATTLE_TYPE_TRAINER | BATTLE_TYPE_MULTI;
        break;
    default:
        gSpecialVar_0x8004 = USING_SINGLE_BATTLE;
        gBattleTypeFlags = BATTLE_TYPE_LINK | BATTLE_TYPE_TRAINER;
        break;
    }
    PlayMapChosenOrBattleBGM(MUS_VS_TRAINER);
    CleanupOverworldWindowsAndTilemaps();
    TRAINER_BATTLE_PARAM.opponentA = TRAINER_LINK_OPPONENT;
    SetMainCallback2(CB2_InitBattle);
    gMain.savedCallback = CB2_ReturnFromVLinkBattle;
}

static void CB2_ReturnFromVLinkBattle(void)
{
    gBattleTypeFlags &= ~BATTLE_TYPE_LINK_IN_BATTLE;
    gVLink.outcome = gBattleOutcome;
    gVLink.state = VLINK_STATE_DONE;
    if (gReceivedRemoteLinkPlayers)
        CloseLink();
    gVLink.linkOpen = FALSE;
    Overworld_ResetMapMusic();
    LoadPlayerParty();
    SetMainCallback2(CB2_ReturnToField);
}

// The server ended the battle for us: the opponent left (2 = we win) or we were AFK (1 = we lose).
static void AbortVLinkBattle(void)
{
    gBattleOutcome = gVLink.forfeit == 2 ? B_OUTCOME_WON : B_OUTCOME_LOST;
    gVLink.forfeit = 0;
    gMain.inBattle = FALSE;
    FreeBattleResources();
    SetMainCallback2(CB2_ReturnFromVLinkBattle);
}

// Called once per frame from the main loop.
void VLink_Update(void)
{
    if (gVLink.state == VLINK_STATE_IN_BATTLE && gVLink.forfeit && gVLink.magic == VLINK_MAGIC
     && gMain.callback2 != CB2_ReturnFromVLinkBattle)
    {
        AbortVLinkBattle();
        return;
    }
    if (!VLink_IsActive())
    {
        if (gVLink.state == VLINK_STATE_WAITING)
            gVLink.state = VLINK_STATE_IDLE;
        return;
    }
    if (gVLink.startRequest && (gVLink.state == VLINK_STATE_IDLE || gVLink.state == VLINK_STATE_DONE))
        gVLink.state = VLINK_STATE_WAITING;
    if (gVLink.state == VLINK_STATE_WAITING && CanStartBattleNow())
        StartVLinkBattle();
}
