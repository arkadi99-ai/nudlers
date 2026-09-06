import { ensureConnected } from '../../../utils/whatsapp-client.js';
import logger from '../../../utils/logger.js';

// GET /api/whatsapp/groups
//
// Lists every WhatsApp group the connected number is currently a member of,
// with its JID - the only way to target a group send (Baileys has no
// "search by name" API). Lets the user create a family group, add the bot,
// then just pick it from a list instead of digging a JID out of logs.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const client = await ensureConnected();
        const groups = await client.groupFetchAllParticipating();
        const list = Object.values(groups).map((g) => ({
            jid: g.id,
            name: g.subject,
            participantCount: g.participants?.length ?? 0,
        }));
        res.status(200).json({ groups: list });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Error listing WhatsApp groups');
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
