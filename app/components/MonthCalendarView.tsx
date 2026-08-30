import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, IconButton, CircularProgress, Tooltip, Popover, Divider } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';

interface CalendarEvent {
    name: string;
    category: string | null;
    amount: number;
    type: 'fixed' | 'card' | 'actual' | 'estimate';
}

interface CalendarDay {
    date: string;
    day: number;
    balance: number | null;
    dailyChange: number;
    income: number;
    expenses: number;
    estimateTotal: number;
    estimatedBalance: number | null;
    events: CalendarEvent[];
    isFuture: boolean;
    isToday: boolean;
    dayOfWeek: number;
}

interface CalendarResponse {
    month: string;
    currentBalance: number;
    hasBalance: boolean;
    hasEstimates: boolean;
    days: CalendarDay[];
}

const MonthCalendarView: React.FC = () => {
    const theme = useTheme();
    const { t } = useTranslation('views');
    const { locale } = useLocale();
    const dateLocale = locale === 'he' ? 'he-IL' : 'en-US';

    const [monthDate, setMonthDate] = useState(() => {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), 1);
    });
    const [data, setData] = useState<CalendarResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);
    const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);

    const openDayPopover = (e: React.MouseEvent<HTMLElement>, day: CalendarDay) => {
        setPopoverAnchor(e.currentTarget);
        setSelectedDay(day);
    };
    const closeDayPopover = () => {
        setPopoverAnchor(null);
        setSelectedDay(null);
        closeDrillDown();
    };

    const [drillDownAnchor, setDrillDownAnchor] = useState<HTMLElement | null>(null);
    const [drillDownCategory, setDrillDownCategory] = useState<string | null>(null);
    const [drillDownTransactions, setDrillDownTransactions] = useState<Array<{ date: string; name: string; amount: number; source: string }> | null>(null);
    const [drillDownTotals, setDrillDownTotals] = useState<{ threeMonthTotal: number; avgDaily: number } | null>(null);
    const [drillDownLoading, setDrillDownLoading] = useState(false);

    const openDrillDown = async (e: React.MouseEvent<HTMLElement>, category: string) => {
        e.stopPropagation();
        setDrillDownAnchor(e.currentTarget);
        setDrillDownCategory(category);
        setDrillDownTransactions(null);
        setDrillDownTotals(null);
        setDrillDownLoading(true);
        try {
            const res = await fetch(`/api/reports/category-transactions?category=${encodeURIComponent(category)}`);
            const result = await res.json();
            setDrillDownTransactions(result.transactions || []);
            setDrillDownTotals({ threeMonthTotal: result.threeMonthTotal ?? 0, avgDaily: result.avgDaily ?? 0 });
        } catch (err) {
            console.error('Failed to fetch category transactions', err);
            setDrillDownTransactions([]);
        } finally {
            setDrillDownLoading(false);
        }
    };
    const closeDrillDown = () => {
        setDrillDownAnchor(null);
        setDrillDownCategory(null);
        setDrillDownTransactions(null);
        setDrillDownTotals(null);
    };

    const monthStr = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;

    const fetchCalendar = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/reports/month-calendar?month=${monthStr}`);
            const result = await res.json();
            setData(result);
        } catch (err) {
            console.error('Failed to fetch month calendar', err);
        } finally {
            setLoading(false);
        }
    }, [monthStr]);

    useEffect(() => {
        queueMicrotask(() => fetchCalendar());
        // Recompute whenever a sync brings in new data - the calendar's numbers
        // (actual reconstruction + projections) are only as fresh as the last sync.
        const handler = () => fetchCalendar();
        window.addEventListener('dataRefresh', handler);
        return () => window.removeEventListener('dataRefresh', handler);
    }, [fetchCalendar]);

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0 }).format(amount);
    };

    const monthLabel = monthDate.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' });
    const weekdayLabels = React.useMemo(() => {
        // Sunday-first, matching Israeli calendar convention regardless of RTL layout.
        const base = new Date(2026, 0, 4); // a Sunday
        return Array.from({ length: 7 }, (_, i) => {
            const d = new Date(base);
            d.setDate(base.getDate() + i);
            return d.toLocaleDateString(dateLocale, { weekday: 'short' });
        });
    }, [dateLocale]);

    const days = data?.days || [];
    const leadingBlanks = days.length > 0 ? days[0].dayOfWeek : 0;

    const goToMonth = (delta: number) => {
        setMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
    };

    return (
        <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: '1200px', margin: '0 auto' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <CalendarMonthIcon sx={{ fontSize: 32 }} className="gradient-text" />
                    <Box>
                        <Typography variant="h5" sx={{ fontWeight: 800 }}>{t('projection.calendarTitle')}</Typography>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('projection.calendarDescription')}</Typography>
                    </Box>
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <IconButton onClick={() => goToMonth(-1)} size="small" sx={{ border: `1px solid ${theme.palette.divider}` }}>
                        <ChevronRightIcon />
                    </IconButton>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: '140px', textAlign: 'center' }}>
                        {monthLabel}
                    </Typography>
                    <IconButton onClick={() => goToMonth(1)} size="small" sx={{ border: `1px solid ${theme.palette.divider}` }}>
                        <ChevronLeftIcon />
                    </IconButton>
                </Box>
            </Box>

            {!loading && data && !data.hasBalance && (
                <Box sx={{ p: 2, mb: 2, borderRadius: '12px', bgcolor: 'rgba(251, 191, 36, 0.1)', border: '1px solid rgba(251, 191, 36, 0.3)' }}>
                    <Typography variant="body2" sx={{ color: '#d97706' }}>{t('projection.calendarNoBalanceWarning')}</Typography>
                </Box>
            )}

            {!loading && data && data.hasEstimates && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, px: 1 }}>
                    <Box sx={{ width: 14, height: 14, borderRadius: '4px', bgcolor: 'rgba(253, 224, 71, 0.35)', border: '1px solid #B08900' }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {t('projection.calendarEstimateLegend')}
                    </Typography>
                </Box>
            )}

            <Box className="n-card n-glass" sx={{ p: { xs: 1.5, md: 3 }, borderRadius: '32px', position: 'relative', minHeight: '400px' }}>
                {loading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
                        <CircularProgress />
                    </Box>
                ) : (
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: { xs: 0.5, md: 1 } }}>
                        {weekdayLabels.map((label) => (
                            <Box key={label} sx={{ textAlign: 'center', pb: 1 }}>
                                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>{label}</Typography>
                            </Box>
                        ))}

                        {Array.from({ length: leadingBlanks }).map((_, i) => (
                            <Box key={`blank-${i}`} />
                        ))}

                        {days.map((day) => {
                            const isPositive = (day.balance ?? 0) >= 0;
                            const balanceColor = day.balance === null
                                ? theme.palette.text.disabled
                                : isPositive ? '#10B981' : '#F43F5E';
                            const hasIncome = day.income >= 1;
                            const hasExpenses = day.expenses <= -1;
                            const hasEstimate = Math.abs(day.estimateTotal) >= 1;

                            // The "bottom line" for this day - includes the estimate when there
                            // is one (future days), otherwise just the real/scheduled balance.
                            // Drives the cell's own background tint, so the overall verdict for
                            // the day (green = still in credit, red = would go into overdraft)
                            // is visible at a glance without misreading any single line-item's
                            // sign as if it were the final result.
                            const summaryValue = day.estimatedBalance ?? day.balance;
                            const summaryIsNegative = summaryValue !== null && summaryValue < 0;

                            const tooltipParts = [];
                            if (day.dailyChange !== 0) tooltipParts.push(`${day.dailyChange > 0 ? '+' : ''}${formatCurrency(day.dailyChange)}`);
                            if (hasEstimate) tooltipParts.push(`${t('projection.calendarEstimateTooltip')}: ${formatCurrency(day.estimateTotal)}`);
                            const tooltipTitle = tooltipParts.join(' · ');

                            return (
                                <Tooltip
                                    key={day.date}
                                    title={tooltipTitle}
                                    disableHoverListener={!tooltipTitle}
                                >
                                    <Box
                                        onClick={(e) => openDayPopover(e, day)}
                                        sx={{
                                            aspectRatio: '1 / 1',
                                            borderRadius: '14px',
                                            p: { xs: 0.5, md: 1 },
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'space-between',
                                            cursor: 'pointer',
                                            bgcolor: summaryValue === null
                                                ? (theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)')
                                                : summaryIsNegative ? 'rgba(244, 67, 54, 0.1)' : 'rgba(16, 185, 129, 0.08)',
                                            border: day.isToday ? `2px solid ${theme.palette.primary.main}` : `1px solid ${theme.palette.divider}`,
                                            opacity: day.isFuture ? 0.85 : 1,
                                            transition: 'all 0.2s',
                                            '&:hover': {
                                                borderColor: theme.palette.primary.main,
                                                transform: 'scale(1.03)'
                                            }
                                        }}
                                    >
                                        <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', fontSize: { xs: '0.65rem', md: '0.75rem' } }}>
                                            {day.day}
                                        </Typography>
                                        {day.balance !== null && (
                                            <Typography
                                                sx={{
                                                    fontWeight: 800,
                                                    fontSize: { xs: '0.6rem', md: '0.75rem' },
                                                    color: balanceColor,
                                                    lineHeight: 1.2,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    direction: 'ltr',
                                                    textAlign: 'center'
                                                }}
                                            >
                                                {formatCurrency(day.balance)}
                                            </Typography>
                                        )}
                                        {hasIncome && (
                                            <Typography sx={{ fontSize: { xs: '0.5rem', md: '0.6rem' }, fontWeight: 600, color: '#10B981', direction: 'ltr', textAlign: 'center' }}>
                                                +{formatCurrency(day.income)}
                                            </Typography>
                                        )}
                                        {hasExpenses && (
                                            <Typography sx={{ fontSize: { xs: '0.5rem', md: '0.6rem' }, fontWeight: 600, color: '#F43F5E', direction: 'ltr', textAlign: 'center' }}>
                                                {formatCurrency(day.expenses)}
                                            </Typography>
                                        )}
                                        {hasEstimate && (
                                            <Typography
                                                sx={{
                                                    fontSize: { xs: '0.5rem', md: '0.6rem' },
                                                    fontWeight: 700,
                                                    color: '#B08900',
                                                    bgcolor: 'rgba(253, 224, 71, 0.35)',
                                                    borderRadius: '6px',
                                                    px: '3px',
                                                    lineHeight: 1.3,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    direction: 'ltr',
                                                    textAlign: 'center'
                                                }}
                                            >
                                                {formatCurrency(day.estimateTotal)}
                                            </Typography>
                                        )}
                                    </Box>
                                </Tooltip>
                            );
                        })}
                    </Box>
                )}
            </Box>

            <Popover
                open={Boolean(popoverAnchor)}
                anchorEl={popoverAnchor}
                onClose={closeDayPopover}
                anchorOrigin={{ vertical: 'center', horizontal: 'center' }}
                transformOrigin={{ vertical: 'center', horizontal: 'center' }}
                slotProps={{ paper: { sx: { borderRadius: '20px', p: 2, minWidth: '260px', maxWidth: '320px' } } }}
            >
                {selectedDay && (() => {
                    const incomeEvents = selectedDay.events.filter(e => e.type !== 'estimate' && e.amount >= 1);
                    const expenseEvents = selectedDay.events.filter(e => e.type !== 'estimate' && e.amount <= -1);
                    const estimateEvents = selectedDay.events.filter(e => e.type === 'estimate' && Math.abs(e.amount) >= 1);
                    const summaryValue = selectedDay.estimatedBalance ?? selectedDay.balance ?? 0;

                    const renderLine = (e: CalendarEvent, i: number) => (
                        <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}>
                            <Box>
                                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{e.name}</Typography>
                                {e.type === 'fixed' && e.category && e.category !== e.name && (
                                    <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>{e.category}</Typography>
                                )}
                            </Box>
                            <Typography variant="body2" sx={{ fontWeight: 700, color: e.amount >= 0 ? '#10B981' : '#F43F5E', whiteSpace: 'nowrap', direction: 'ltr' }}>
                                {e.amount > 0 ? '+' : ''}{formatCurrency(e.amount)}
                            </Typography>
                        </Box>
                    );

                    return (
                        <Box sx={{ minWidth: '280px' }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>
                                {new Date(selectedDay.date).toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', year: 'numeric' })}
                            </Typography>

                            {/* Balance - the reference point for the day */}
                            {selectedDay.balance !== null && (
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{t('projection.totalBalance')}</Typography>
                                    <Typography variant="body2" sx={{ fontWeight: 800, direction: 'ltr', color: selectedDay.balance >= 0 ? '#10B981' : '#F43F5E' }}>
                                        {formatCurrency(selectedDay.balance)}
                                    </Typography>
                                </Box>
                            )}

                            {selectedDay.events.length === 0 ? (
                                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                    {t('projection.calendarNoEvents')}
                                </Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                                    {/* Income (green) */}
                                    {incomeEvents.length > 0 && (
                                        <>
                                            <Divider sx={{ my: 0.5 }} />
                                            {incomeEvents.map(renderLine)}
                                        </>
                                    )}

                                    {/* Expenses (red) */}
                                    {expenseEvents.length > 0 && (
                                        <>
                                            <Divider sx={{ my: 0.5 }} />
                                            {expenseEvents.map(renderLine)}
                                        </>
                                    )}

                                    {/* Estimate (yellow, per category, clickable for the real transactions behind it) */}
                                    {estimateEvents.length > 0 && (() => {
                                        const estimateTotal = estimateEvents.reduce((sum, e) => sum + e.amount, 0);
                                        return (
                                            <>
                                                <Divider sx={{ my: 0.5 }} />
                                                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                                                    {t('projection.calendarEstimateBreakdownLabel')}
                                                </Typography>
                                                <Box sx={{
                                                    display: 'flex', flexDirection: 'column', gap: 0.5,
                                                    bgcolor: 'rgba(253, 224, 71, 0.2)', borderRadius: '10px', p: 1
                                                }}>
                                                    {estimateEvents.map((e, i) => (
                                                        <Box
                                                            key={i}
                                                            onClick={(ev) => e.category && openDrillDown(ev, e.category)}
                                                            sx={{
                                                                display: 'flex', justifyContent: 'space-between', gap: 2,
                                                                cursor: 'pointer', borderRadius: '6px', px: 0.5,
                                                                '&:hover': { bgcolor: 'rgba(176, 137, 0, 0.15)' }
                                                            }}
                                                        >
                                                            <Typography variant="body1" sx={{ color: '#c9a600', fontWeight: 600 }}>{e.name}</Typography>
                                                            <Typography variant="body2" sx={{ fontWeight: 700, color: '#B08900', whiteSpace: 'nowrap', direction: 'ltr' }}>
                                                                {formatCurrency(e.amount)}
                                                            </Typography>
                                                        </Box>
                                                    ))}
                                                    <Divider sx={{ my: 0.25, borderColor: 'rgba(176, 137, 0, 0.3)' }} />
                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                                                        <Typography variant="body2" sx={{ color: '#8a6d00', fontWeight: 700 }}>{t('projection.calendarEstimateTotalLabel')}</Typography>
                                                        <Typography variant="body2" sx={{ fontWeight: 800, color: '#B08900', whiteSpace: 'nowrap', direction: 'ltr' }}>
                                                            {formatCurrency(estimateTotal)}
                                                        </Typography>
                                                    </Box>
                                                </Box>
                                            </>
                                        );
                                    })()}

                                    {/* Summary - the true bottom line, colored as a pill matching its own sign */}
                                    <Divider sx={{ my: 0.5 }} />
                                    <Box sx={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2,
                                        p: 1, borderRadius: '10px',
                                        bgcolor: summaryValue >= 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 67, 54, 0.12)'
                                    }}>
                                        <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                            {selectedDay.estimatedBalance !== null ? t('projection.calendarEstimateBalanceLabel') : t('projection.projectedBalance')}
                                        </Typography>
                                        <Typography variant="body2" sx={{
                                            fontWeight: 800,
                                            direction: 'ltr',
                                            color: summaryValue >= 0 ? '#10B981' : '#F43F5E'
                                        }}>
                                            {formatCurrency(summaryValue)}
                                        </Typography>
                                    </Box>
                                </Box>
                            )}
                        </Box>
                    );
                })()}
            </Popover>

            <Popover
                open={Boolean(drillDownAnchor)}
                anchorEl={drillDownAnchor}
                onClose={closeDrillDown}
                anchorOrigin={{ vertical: 'center', horizontal: 'center' }}
                transformOrigin={{ vertical: 'center', horizontal: 'center' }}
                slotProps={{ paper: { sx: { borderRadius: '20px', p: 2, minWidth: '320px', maxWidth: '420px', maxHeight: '400px', overflowY: 'auto' } } }}
            >
                <Box>
                    <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.5 }}>{drillDownCategory}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
                        {t('projection.calendarDrillDownSubtitle')}
                    </Typography>
                    {drillDownTotals && (
                        <Box sx={{
                            display: 'flex', justifyContent: 'space-between', gap: 2, mb: 1.5,
                            p: 1, borderRadius: '10px', bgcolor: 'rgba(253, 224, 71, 0.15)'
                        }}>
                            <Typography variant="caption" sx={{ color: '#8a6d00', fontWeight: 600 }}>
                                {t('projection.calendarDrillDownReconciliation', {
                                    total: formatCurrency(drillDownTotals.threeMonthTotal),
                                    daily: formatCurrency(drillDownTotals.avgDaily)
                                })}
                            </Typography>
                        </Box>
                    )}
                    {drillDownLoading ? (
                        <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                            <CircularProgress size={24} />
                        </Box>
                    ) : drillDownTransactions && drillDownTransactions.length > 0 ? (
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            {drillDownTransactions.map((tx, i) => (
                                <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 2, pb: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
                                    <Box sx={{ minWidth: 0 }}>
                                        <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.name}</Typography>
                                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                            {new Date(tx.date).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' })} · {tx.source}
                                        </Typography>
                                    </Box>
                                    <Typography variant="body2" sx={{ fontWeight: 700, color: '#F43F5E', whiteSpace: 'nowrap', direction: 'ltr' }}>
                                        {formatCurrency(tx.amount)}
                                    </Typography>
                                </Box>
                            ))}
                        </Box>
                    ) : (
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('projection.calendarNoEvents')}</Typography>
                    )}
                </Box>
            </Popover>
        </Box>
    );
};

export default MonthCalendarView;
