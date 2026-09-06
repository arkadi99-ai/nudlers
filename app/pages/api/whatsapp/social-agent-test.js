import logger from '../../../utils/logger.js';

// POST /api/whatsapp/social-agent-test
// Body: { send: boolean } - false (default) just generates+returns the
// message and the facts it was built from (a dry run, safe to call anytime
// to see what the agent would say); true actually sends it to the
// configured whatsapp_group_jid.
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const send = req.body?.send === true;
        const mode = req.body?.mode === 'ask' ? 'ask' : 'update';

        if (mode === 'ask') {
            if (!send) {
                return res.status(400).json({ error: '"ask" mode always sends (it needs a real WhatsApp message ID to track the reply against) - pass send:true' });
            }
            const { askAboutNextUnclearExpense } = await import('../../../utils/socialAgent.js');
            const outcome = await askAboutNextUnclearExpense();
            return res.status(200).json(outcome);
        }

        if (!send) {
            const { generateSocialAgentMessage } = await import('../../../utils/socialAgent.js');
            const { text, facts } = await generateSocialAgentMessage({ periodLabel: 'test' });
            return res.status(200).json({ sent: false, text, facts });
        }

        const { sendSocialAgentUpdate } = await import('../../../utils/socialAgent.js');
        const outcome = await sendSocialAgentUpdate({ periodLabel: 'test' });
        return res.status(200).json(outcome);
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Error in social-agent-test');
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
