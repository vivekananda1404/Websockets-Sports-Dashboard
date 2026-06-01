import { Router } from 'express';
import { createMatchSchema, listMatchesQuerySchema } from "../validation/matches.js";
import { matches } from "../db/schema.js";
import { db } from "../db/db.js";
import { getMatchStatus } from "../utils/match-status.js";
import { desc, eq } from "drizzle-orm";

export const matchRouter = Router();

const MAX_LIMIT = 100;

/* ---------------- GET ---------------- */
matchRouter.get('/', async (req, res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);

    if (!parsed.success) {
        return res.status(400).json({
            error: 'Invalid query.',
            details: parsed.error.issues
        });
    }

    const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);

    try {
        const data = await db
            .select()
            .from(matches)
            .orderBy(desc(matches.createdAt))
            .limit(limit);

        res.json({ data });
    } catch (e) {
        res.status(500).json({ error: 'Failed to list matches.' });
    }
});


/* ---------------- POST ---------------- */
matchRouter.post('/', async (req, res) => {
    const parsed = createMatchSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: 'Invalid payload.',
            details: parsed.error.issues
        });
    }

    const {
        data: { startTime, endTime, homeScore, awayScore }
    } = parsed;

    try {
        const [event] = await db.insert(matches).values({
            ...parsed.data,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            homeScore: homeScore ?? 0,
            awayScore: awayScore ?? 0,
            status: getMatchStatus(startTime, endTime),
        }).returning();

        if (res.app.locals.broadcastMatchCreated) {
            res.app.locals.broadcastMatchCreated(event);
        }

        res.status(201).json({ data: event });

    } catch (e) {
        res.status(500).json({
            error: 'Failed to create match.',
            details: JSON.stringify(e)
        });
    }
});


/* ---------------- PATCH SCORE ---------------- */
matchRouter.patch('/:id/score', async (req, res) => {
    const matchId = req.params.id;
    const { homeScore, awayScore } = req.body;

    if (typeof homeScore !== 'number' || typeof awayScore !== 'number') {
        return res.status(400).json({ error: "Invalid score values" });
    }

    try {
        const [updated] = await db
            .update(matches)
            .set({ homeScore, awayScore })
            .where(eq(matches.id, matchId))
            .returning();

        if (!updated) {
            return res.status(404).json({ error: "Match not found" });
        }

        // 🔥 DEBUG LOG (THIS is where you will see it)
        console.log(
            "broadcastScoreUpdate exists?",
            !!res.app.locals.broadcastScoreUpdate
        );

        if (res.app.locals.broadcastScoreUpdate) {
            res.app.locals.broadcastScoreUpdate(matchId, {
                homeScore: updated.homeScore,
                awayScore: updated.awayScore,
            });
        }

        res.json({ data: updated });

    } catch (e) {
        res.status(500).json({
            error: 'Failed to update score.',
            details: JSON.stringify(e)
        });
    }
});