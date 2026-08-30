import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';

interface AccountStatus {
    currentBalance: number;
    hasBalance: boolean;
    fixedMonthlyTotal: number;
    nextCardSettlement: { date: string; amount: number; cards: string[] } | null;
}

const AccountStatusCard: React.FC = () => {
    const theme = useTheme();
    const { t } = useTranslation('views');
    const { locale } = useLocale();
    const dateLocale = locale === 'he' ? 'he-IL' : 'en-US';

    const [data, setData] = useState<AccountStatus | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/reports/account-status');
            const result = await res.json();
            setData(result);
        } catch (err) {
            console.error('Failed to fetch account status', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        queueMicrotask(() => fetchStatus());
        const handler = () => fetchStatus();
        window.addEventListener('dataRefresh', handler);
        return () => window.removeEventListener('dataRefresh', handler);
    }, [fetchStatus]);

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(amount);
    };

    if (loading) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3, m: { xs: '12px 4px', md: '0 16px 24px' } }}>
                <CircularProgress size={28} />
            </Box>
        );
    }

    if (!data) return null;

    const balanceColor = !data.hasBalance
        ? theme.palette.text.disabled
        : data.currentBalance >= 0 ? '#10B981' : '#F43F5E';

    return (
        <Box
            className="n-card n-glass"
            sx={{
                margin: { xs: '12px 4px', md: '0 16px 24px' },
                padding: { xs: '16px', md: '24px' },
                borderRadius: '24px',
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
                gap: { xs: 2, sm: 3 },
            }}
        >
            {/* Current Balance */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <AccountBalanceWalletIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                    <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                        {t('summary.accountStatus.currentBalance')}
                    </Typography>
                </Box>
                <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.5rem', md: '1.75rem' }, color: balanceColor }}>
                    {data.hasBalance ? formatCurrency(data.currentBalance) : t('summary.accountStatus.noBalance')}
                </Typography>
            </Box>

            {/* Fixed Expenses Total */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ReceiptLongIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                    <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                        {t('summary.accountStatus.fixedMonthlyTotal')}
                    </Typography>
                </Box>
                <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.5rem', md: '1.75rem' }, color: '#F43F5E' }}>
                    {formatCurrency(data.fixedMonthlyTotal)}
                </Typography>
            </Box>

            {/* Next Card Settlement */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CreditCardIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                    <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                        {t('summary.accountStatus.nextCardSettlement')}
                    </Typography>
                </Box>
                {data.nextCardSettlement ? (
                    <>
                        <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.5rem', md: '1.75rem' }, color: '#F43F5E' }}>
                            {formatCurrency(data.nextCardSettlement.amount)}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <CalendarTodayIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                {new Date(data.nextCardSettlement.date).toLocaleDateString(dateLocale, { day: 'numeric', month: 'long' })}
                                {data.nextCardSettlement.cards.length > 0 ? ` · ${data.nextCardSettlement.cards.join(', ')}` : ''}
                            </Typography>
                        </Box>
                    </>
                ) : (
                    <Typography sx={{ fontWeight: 700, color: 'text.disabled' }}>
                        {t('summary.accountStatus.noUpcomingSettlement')}
                    </Typography>
                )}
            </Box>
        </Box>
    );
};

export default AccountStatusCard;
