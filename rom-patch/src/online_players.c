#include "global.h"
#include "event_object_movement.h"
#include "field_player_avatar.h"
#include "fieldmap.h"
#include "online_players.h"
#include "constants/event_object_movement.h"
#include "constants/event_objects.h"

// See include/online_players.h. Kept in EWRAM so the web client finds them at fixed addresses.
EWRAM_DATA struct OnlinePlayer gOnlinePlayers[ONLINE_PLAYERS_MAX] = {0};
EWRAM_DATA u32 gOnlinePlayersMagic = 0;
EWRAM_DATA struct OnlineSelf gOnlineSelf = {0};

// Only spawn ghosts close to the camera; RemoveObjectEventsOutsideView would delete farther ones.
#define SPAWN_RANGE_X 8
#define SPAWN_RANGE_Y 6
// Farther than this from where the ghost stands, it is moved instantly instead of walking.
#define TELEPORT_DISTANCE 6

static inline s32 Abs(s32 v)
{
    return v < 0 ? -v : v;
}

static void ExportSelf(void)
{
    struct ObjectEvent *player = &gObjectEvents[gPlayerAvatar.objectEventId];

    gOnlineSelf.mapGroup = gSaveBlock1Ptr->location.mapGroup;
    gOnlineSelf.mapNum = gSaveBlock1Ptr->location.mapNum;
    gOnlineSelf.x = player->currentCoords.x - MAP_OFFSET;
    gOnlineSelf.y = player->currentCoords.y - MAP_OFFSET;
    gOnlineSelf.facing = player->facingDirection;
    gOnlineSelf.elevation = player->currentElevation;
    gOnlineSelf.graphicsId = player->graphicsId;
    gOnlineSelf.frame++;
    gOnlineSelf.magic = ONLINE_PLAYERS_MAGIC;
}

static bool32 IsValidFacing(u8 facing)
{
    return facing >= DIR_SOUTH && facing <= DIR_EAST;
}

static void UpdateGhost(u32 slot)
{
    const struct OnlinePlayer *remote = &gOnlinePlayers[slot];
    const struct ObjectEvent *player = &gObjectEvents[gPlayerAvatar.objectEventId];
    u8 localId = LOCALID_ONLINE_PLAYER_START + slot;
    u8 mapNum = gSaveBlock1Ptr->location.mapNum;
    u8 mapGroup = gSaveBlock1Ptr->location.mapGroup;
    u8 objectEventId;
    bool32 exists = !TryGetObjectEventIdByLocalIdAndMap(localId, mapNum, mapGroup, &objectEventId);
    struct ObjectEvent *ghost;
    s16 targetX, targetY, dx, dy;
    s32 distance;
    enum Direction direction;
    u8 facing = IsValidFacing(remote->facing) ? remote->facing : DIR_SOUTH;

    bool32 visible = gOnlinePlayersMagic == ONLINE_PLAYERS_MAGIC
                  && remote->active
                  && remote->mapGroup == (s8)mapGroup
                  && remote->mapNum == (s8)mapNum; // graphicsId 0 is Brendan, a valid sprite

    targetX = remote->x + MAP_OFFSET;
    targetY = remote->y + MAP_OFFSET;

    if (!visible)
    {
        if (exists)
            RemoveObjectEventByLocalIdAndMap(localId, mapNum, mapGroup);
        return;
    }

    if (!exists)
    {
        if (Abs(targetX - player->currentCoords.x) > SPAWN_RANGE_X || Abs(targetY - player->currentCoords.y) > SPAWN_RANGE_Y)
            return;
        objectEventId = SpawnSpecialObjectEventParameterized(remote->graphicsId, MOVEMENT_TYPE_NONE, localId, targetX, targetY, remote->elevation);
        if (objectEventId < OBJECT_EVENTS_COUNT)
            ObjectEventTurn(&gObjectEvents[objectEventId], facing);
        return;
    }

    ghost = &gObjectEvents[objectEventId];

    // Still walking the previous step.
    if (ObjectEventClearHeldMovementIfFinished(ghost) == 0)
        return;

    if (ghost->graphicsId != remote->graphicsId)
        ObjectEventSetGraphicsId(ghost, remote->graphicsId);

    dx = targetX - ghost->currentCoords.x;
    dy = targetY - ghost->currentCoords.y;
    distance = Abs(dx) + Abs(dy);

    if (distance == 0)
    {
        if (ghost->facingDirection != facing)
            ObjectEventTurn(ghost, facing);
        ghost->currentElevation = ghost->previousElevation = remote->elevation;
        return;
    }

    if (distance > TELEPORT_DISTANCE)
    {
        ghost->currentElevation = ghost->previousElevation = remote->elevation;
        MoveObjectEventToMapCoords(ghost, targetX, targetY);
        ObjectEventTurn(ghost, facing);
        return;
    }

    if (Abs(dx) >= Abs(dy))
        direction = dx > 0 ? DIR_EAST : DIR_WEST;
    else
        direction = dy > 0 ? DIR_SOUTH : DIR_NORTH;

    // Catch up faster when the remote player is several tiles ahead (running, biking, lag).
    if (distance >= 3)
        ObjectEventSetHeldMovement(ghost, GetWalkFasterMovementAction(direction));
    else if (distance == 2)
        ObjectEventSetHeldMovement(ghost, GetWalkFastMovementAction(direction));
    else
        ObjectEventSetHeldMovement(ghost, GetWalkNormalMovementAction(direction));
}

void OnlinePlayers_Update(void)
{
    u32 i;

    if (gPlayerAvatar.objectEventId >= OBJECT_EVENTS_COUNT)
        return;

    ExportSelf();
    for (i = 0; i < ONLINE_PLAYERS_MAX; i++)
        UpdateGhost(i);
}
