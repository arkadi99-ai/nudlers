import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, LinearProgress, IconButton, TextField, Button, Dialog, DialogContent } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/Delete';
import FlagIcon from '@mui/icons-material/Flag';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
import ModalHeader from './ModalHeader';

interface Goal {
    id: number;
    name: string;
    target_amount: number;
    current_amount: number;
    target_date: string | null;
}

const SavingsGoalsCard: React.FC = () => {
    const theme = useTheme();
    const { t } = useTranslation('views');
    const { locale } = useLocale();
    const dateLocale = locale === 'he' ? 'he-IL' : 'en-US';

    const [goals, setGoals] = useState<Goal[]>([]);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editingAmount, setEditingAmount] = useState('');
    const [addOpen, setAddOpen] = useState(false);
    const [newGoal, setNewGoal] = useState({ name: '', target_amount: '', current_amount: '', target_date: '' });

    const fetchGoals = useCallback(async () => {
        try {
            const res = await fetch('/api/goals');
            const data = await res.json();
            setGoals(data);
        } catch (err) {
            console.error('Failed to fetch savings goals', err);
        }
    }, []);

    useEffect(() => {
        queueMicrotask(() => fetchGoals());
        const handler = () => fetchGoals();
        window.addEventListener('dataRefresh', handler);
        return () => window.removeEventListener('dataRefresh', handler);
    }, [fetchGoals]);

    const formatCurrency = (amount: number) =>
        new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(amount);

    const saveAmount = async (goal: Goal, amount: number) => {
        setGoals(prev => prev.map(g => g.id === goal.id ? { ...g, current_amount: amount } : g));
        await fetch('/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...goal, current_amount: amount }),
        });
        setEditingId(null);
    };

    const deleteGoal = async (id: number) => {
        setGoals(prev => prev.filter(g => g.id !== id));
        await fetch('/api/goals', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
    };

    const createGoal = async () => {
        if (!newGoal.name.trim() || !newGoal.target_amount) return;
        const res = await fetch('/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: newGoal.name.trim(),
                target_amount: parseFloat(newGoal.target_amount),
                current_amount: newGoal.current_amount ? parseFloat(newGoal.current_amount) : 0,
                target_date: newGoal.target_date || null,
            }),
        });
        const created = await res.json();
        setGoals(prev => [...prev, created]);
        setNewGoal({ name: '', target_amount: '', current_amount: '', target_date: '' });
        setAddOpen(false);
    };

    const daysRemaining = (targetDate: string | null) => {
        if (!targetDate) return null;
        const diff = Math.ceil((new Date(targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        return diff;
    };

    return (
        <Box
            className="n-card n-glass"
            sx={{
                margin: { xs: '12px 4px', md: '0 16px 24px' },
                padding: { xs: '16px', md: '24px' },
                borderRadius: '24px',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <FlagIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                    <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                        {t('summary.savingsGoals.title')}
                    </Typography>
                </Box>
                <IconButton size="small" onClick={() => setAddOpen(true)} sx={{ color: 'primary.main' }}>
                    <AddIcon />
                </IconButton>
            </Box>

            {goals.length === 0 ? (
                <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic', py: 1 }}>
                    {t('summary.savingsGoals.empty')}
                </Typography>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {goals.map(goal => {
                        const pct = Math.min(100, Math.round((goal.current_amount / goal.target_amount) * 100));
                        const remaining = daysRemaining(goal.target_date);
                        return (
                            <Box key={goal.id}>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                                    <Typography sx={{ fontWeight: 600 }}>{goal.name}</Typography>
                                    <IconButton size="small" onClick={() => deleteGoal(goal.id)} sx={{ color: 'text.disabled' }}>
                                        <DeleteOutlineIcon fontSize="small" />
                                    </IconButton>
                                </Box>
                                <LinearProgress
                                    variant="determinate"
                                    value={pct}
                                    sx={{
                                        height: 8,
                                        borderRadius: 4,
                                        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                                        '& .MuiLinearProgress-bar': { borderRadius: 4, backgroundColor: '#10B981' },
                                    }}
                                />
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 0.5 }}>
                                    {editingId === goal.id ? (
                                        <TextField
                                            size="small"
                                            type="number"
                                            autoFocus
                                            value={editingAmount}
                                            onChange={(e) => setEditingAmount(e.target.value)}
                                            onBlur={() => saveAmount(goal, parseFloat(editingAmount) || 0)}
                                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); }}
                                            sx={{ width: 120 }}
                                        />
                                    ) : (
                                        <Typography
                                            variant="body2"
                                            sx={{ color: 'text.secondary', cursor: 'pointer' }}
                                            onClick={() => { setEditingId(goal.id); setEditingAmount(String(goal.current_amount)); }}
                                        >
                                            {formatCurrency(goal.current_amount)} / {formatCurrency(goal.target_amount)} ({pct}%)
                                        </Typography>
                                    )}
                                    {remaining !== null && (
                                        <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                                            {remaining >= 0
                                                ? t('summary.savingsGoals.daysRemaining', { count: remaining })
                                                : t('summary.savingsGoals.overdue')}
                                        </Typography>
                                    )}
                                </Box>
                            </Box>
                        );
                    })}
                </Box>
            )}

            <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="xs" fullWidth>
                <ModalHeader title={t('summary.savingsGoals.addTitle')} onClose={() => setAddOpen(false)} />
                <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
                    <TextField
                        label={t('summary.savingsGoals.nameLabel')}
                        value={newGoal.name}
                        onChange={(e) => setNewGoal(prev => ({ ...prev, name: e.target.value }))}
                        fullWidth
                        autoFocus
                    />
                    <TextField
                        label={t('summary.savingsGoals.targetAmountLabel')}
                        type="number"
                        value={newGoal.target_amount}
                        onChange={(e) => setNewGoal(prev => ({ ...prev, target_amount: e.target.value }))}
                        fullWidth
                    />
                    <TextField
                        label={t('summary.savingsGoals.currentAmountLabel')}
                        type="number"
                        value={newGoal.current_amount}
                        onChange={(e) => setNewGoal(prev => ({ ...prev, current_amount: e.target.value }))}
                        fullWidth
                    />
                    <TextField
                        label={t('summary.savingsGoals.targetDateLabel')}
                        type="date"
                        value={newGoal.target_date}
                        onChange={(e) => setNewGoal(prev => ({ ...prev, target_date: e.target.value }))}
                        fullWidth
                        slotProps={{ inputLabel: { shrink: true } }}
                    />
                    <Button variant="contained" onClick={createGoal} disabled={!newGoal.name.trim() || !newGoal.target_amount}>
                        {t('summary.savingsGoals.save')}
                    </Button>
                </DialogContent>
            </Dialog>
        </Box>
    );
};

export default SavingsGoalsCard;
