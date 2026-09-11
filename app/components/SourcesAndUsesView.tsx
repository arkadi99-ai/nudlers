import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, IconButton, CircularProgress, Alert, Dialog, DialogContent, Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
import ModalHeader from './ModalHeader';

interface SourceRow { name: string; total: number; count: number; percentOfIncome: number }
interface UseRow { category: string; total: number; count: number; percentOfExpenses: number }

interface SourcesAndUsesData {
    startDate: string;
    endDate: string;
    sources: SourceRow[];
    uses: UseRow[];
    totals: { income: number; expenses: number; net: number };
}

interface CategoryTransaction { date: string; name: string; amount: number; source: string; isFixed: boolean }
interface CategoryDrillDown { total: number; transactions: CategoryTransaction[] }

const BAR_COLORS = ['#10B981', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6', '#06B6D4', '#F43F5E', '#84CC16'];

const SourcesAndUsesView: React.FC = () => {
    const theme = useTheme();
    const { t } = useTranslation('views');
    const { locale } = useLocale();
    const dateLocale = locale === 'he' ? 'he-IL' : 'en-US';

    const [monthDate, setMonthDate] = useState(() => new Date());
    const [data, setData] = useState<SourcesAndUsesData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [drillDown, setDrillDown] = useState<CategoryDrillDown | null>(null);
    const [drillDownLoading, setDrillDownLoading] = useState(false);
    const [drillDownError, setDrillDownError] = useState(false);
    const [openItem, setOpenItem] = useState<{ kind: 'source' | 'category'; key: string } | null>(null);

    const fetchData = useCallback(async (date: Date) => {
        setLoading(true);
        setError(false);
        try {
            const start = new Date(date.getFullYear(), date.getMonth(), 1);
            const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
            const fmt = (d: Date) => d.toISOString().slice(0, 10);
            const res = await fetch(`/api/reports/sources-and-uses?startDate=${fmt(start)}&endDate=${fmt(end)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            setData(result);
        } catch (err) {
            console.error('Failed to fetch sources and uses', err);
            setError(true);
            setData(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { queueMicrotask(() => fetchData(monthDate)); }, [monthDate, fetchData]);

    const openDrillDown = useCallback(async (kind: 'source' | 'category', key: string) => {
        if (!data) return;
        setOpenItem({ kind, key });
        setDrillDown(null);
        setDrillDownError(false);
        setDrillDownLoading(true);
        try {
            const endpoint = kind === 'source'
                ? `/api/reports/sources-and-uses/source-transactions?source=${encodeURIComponent(key)}&startDate=${data.startDate}&endDate=${data.endDate}`
                : `/api/reports/sources-and-uses/category-transactions?category=${encodeURIComponent(key)}&startDate=${data.startDate}&endDate=${data.endDate}`;
            const res = await fetch(endpoint);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            setDrillDown(result);
        } catch (err) {
            console.error('Failed to fetch drill-down transactions', err);
            setDrillDownError(true);
        } finally {
            setDrillDownLoading(false);
        }
    }, [data]);

    const closeDrillDown = () => {
        setOpenItem(null);
        setDrillDown(null);
        setDrillDownError(false);
    };

    const goToMonth = (delta: number) => {
        setMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
    };

    const monthLabel = monthDate.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' });
    const formatCurrency = (amount: number) =>
        new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(amount);

    const maxSource = data?.sources.length ? Math.max(...data.sources.map(s => s.total)) : 0;
    const maxUse = data?.uses.length ? Math.max(...data.uses.map(u => u.total)) : 0;

    return (
        <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1100, mx: 'auto' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>{t('sourcesAndUses.title')}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <IconButton onClick={() => goToMonth(-1)} size="small" sx={{ border: `1px solid ${theme.palette.divider}` }}>
                        <ChevronRightIcon />
                    </IconButton>
                    <Typography sx={{ fontWeight: 600, minWidth: 120, textAlign: 'center' }}>{monthLabel}</Typography>
                    <IconButton onClick={() => goToMonth(1)} size="small" sx={{ border: `1px solid ${theme.palette.divider}` }}>
                        <ChevronLeftIcon />
                    </IconButton>
                </Box>
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>{t('sourcesAndUses.subtitle')}</Typography>

            {data && !loading && !error && (
                <Box
                    className="n-card n-glass"
                    sx={{
                        p: 3,
                        borderRadius: '20px',
                        mb: 3,
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
                        gap: 2,
                    }}
                >
                    <Box>
                        <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5 }}>{t('sourcesAndUses.totalIncome')}</Typography>
                        <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.5rem', md: '1.75rem' }, color: '#10B981', direction: 'ltr' }}>{formatCurrency(data.totals.income)}</Typography>
                    </Box>
                    <Box>
                        <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5 }}>{t('sourcesAndUses.totalExpenses')}</Typography>
                        <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.5rem', md: '1.75rem' }, color: '#F43F5E', direction: 'ltr' }}>{formatCurrency(data.totals.expenses)}</Typography>
                    </Box>
                    <Box>
                        <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600, mb: 0.5 }}>{t('sourcesAndUses.net')}</Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                            {data.totals.net >= 0
                                ? <TrendingUpIcon sx={{ color: '#10B981', fontSize: 22 }} />
                                : <TrendingDownIcon sx={{ color: '#F43F5E', fontSize: 22 }} />
                            }
                            <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.5rem', md: '1.75rem' }, color: data.totals.net >= 0 ? '#10B981' : '#F43F5E', direction: 'ltr' }}>
                                {formatCurrency(data.totals.net)}
                            </Typography>
                        </Box>
                    </Box>
                </Box>
            )}

            {loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                    <CircularProgress size={24} />
                </Box>
            ) : error ? (
                <Alert severity="error" sx={{ my: 2 }}>{t('sourcesAndUses.loadFailed')}</Alert>
            ) : data ? (
                <>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3, mb: 3 }}>
                        {/* Sources */}
                        <Box className="n-card n-glass" sx={{ p: 3, borderRadius: '20px' }}>
                            <Typography sx={{ fontWeight: 700, mb: 2 }}>{t('sourcesAndUses.sources')}</Typography>
                            {data.sources.length === 0 ? (
                                <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>{t('sourcesAndUses.noData')}</Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                    {data.sources.map((s, i) => (
                                        <Box
                                            key={s.name}
                                            onClick={() => openDrillDown('source', s.name)}
                                            sx={{
                                                cursor: 'pointer',
                                                borderRadius: '10px',
                                                p: 0.75,
                                                mx: -0.75,
                                                transition: 'background-color 0.15s',
                                                '&:hover': {
                                                    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
                                                }
                                            }}
                                        >
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                                                <Typography variant="body2" sx={{ fontWeight: 500 }}>{s.name}</Typography>
                                                <Typography variant="body2" sx={{ fontWeight: 700, direction: 'ltr' }}>{formatCurrency(s.total)}</Typography>
                                            </Box>
                                            <Box sx={{ height: 6, borderRadius: 3, backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                                                <Box sx={{ height: '100%', width: `${maxSource > 0 ? (s.total / maxSource) * 100 : 0}%`, backgroundColor: BAR_COLORS[i % BAR_COLORS.length], borderRadius: 3 }} />
                                            </Box>
                                            <Typography variant="caption" sx={{ color: 'text.disabled' }}>{s.percentOfIncome}%</Typography>
                                        </Box>
                                    ))}
                                </Box>
                            )}
                        </Box>

                        {/* Uses */}
                        <Box className="n-card n-glass" sx={{ p: 3, borderRadius: '20px' }}>
                            <Typography sx={{ fontWeight: 700, mb: 2 }}>{t('sourcesAndUses.uses')}</Typography>
                            {data.uses.length === 0 ? (
                                <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>{t('sourcesAndUses.noData')}</Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                    {data.uses.map((u, i) => (
                                        <Box
                                            key={u.category}
                                            onClick={() => openDrillDown('category', u.category)}
                                            sx={{
                                                cursor: 'pointer',
                                                borderRadius: '10px',
                                                p: 0.75,
                                                mx: -0.75,
                                                transition: 'background-color 0.15s',
                                                '&:hover': {
                                                    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
                                                }
                                            }}
                                        >
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                                                <Typography variant="body2" sx={{ fontWeight: 500 }}>{u.category}</Typography>
                                                <Typography variant="body2" sx={{ fontWeight: 700, direction: 'ltr' }}>{formatCurrency(u.total)}</Typography>
                                            </Box>
                                            <Box sx={{ height: 6, borderRadius: 3, backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                                                <Box sx={{ height: '100%', width: `${maxUse > 0 ? (u.total / maxUse) * 100 : 0}%`, backgroundColor: BAR_COLORS[i % BAR_COLORS.length], borderRadius: 3 }} />
                                            </Box>
                                            <Typography variant="caption" sx={{ color: 'text.disabled' }}>{u.percentOfExpenses}%</Typography>
                                        </Box>
                                    ))}
                                </Box>
                            )}
                        </Box>
                    </Box>
                </>
            ) : null}

            <Dialog open={!!openItem} onClose={closeDrillDown} maxWidth="sm" fullWidth>
                <ModalHeader title={openItem?.key || ''} onClose={closeDrillDown} />
                <DialogContent sx={{ pt: 1 }}>
                    {drillDownLoading ? (
                        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                            <CircularProgress size={24} />
                        </Box>
                    ) : drillDownError ? (
                        <Alert severity="error">{t('sourcesAndUses.loadFailed')}</Alert>
                    ) : drillDown ? (
                        <>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, pb: 2, borderBottom: `1px solid ${theme.palette.divider}` }}>
                                <Typography sx={{ fontWeight: 700 }}>{t('sourcesAndUses.categoryTotal')}</Typography>
                                <Typography sx={{ fontWeight: 800, color: openItem?.kind === 'source' ? '#10B981' : '#F43F5E', direction: 'ltr' }}>{formatCurrency(drillDown.total)}</Typography>
                            </Box>
                            {drillDown.transactions.length === 0 ? (
                                <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>{t('sourcesAndUses.noData')}</Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                    {drillDown.transactions.map((tx, i) => (
                                        <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 0.75, borderBottom: i < drillDown.transactions.length - 1 ? `1px solid ${theme.palette.divider}` : 'none' }}>
                                            <Box sx={{ minWidth: 0 }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                                    <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>{tx.name}</Typography>
                                                    {tx.isFixed && (
                                                        <Chip
                                                            label={t('sourcesAndUses.fixed')}
                                                            size="small"
                                                            sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700 }}
                                                        />
                                                    )}
                                                </Box>
                                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                                    {new Date(tx.date).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' })}
                                                    {tx.source ? ` · ${tx.source}` : ''}
                                                </Typography>
                                            </Box>
                                            <Typography variant="body2" sx={{ fontWeight: 700, direction: 'ltr', flexShrink: 0, ml: 2 }}>{formatCurrency(tx.amount)}</Typography>
                                        </Box>
                                    ))}
                                </Box>
                            )}
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Box>
    );
};

export default SourcesAndUsesView;
