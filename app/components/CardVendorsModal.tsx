import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { logger } from '../utils/client-logger';
import {
  Dialog,
  DialogContent,
  Box,
  TextField,
  MenuItem,
  styled,
  Typography,
  useTheme,
  alpha
} from '@mui/material';
import Table from './Table';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import ModalHeader from './ModalHeader';
import { BANK_VENDORS } from '../utils/constants';
import { useSnackbar } from './hooks/useSnackbar';
import SnackbarFeedback from './SnackbarFeedback';

// Card vendor definitions with their logos and colors
export const CARD_VENDORS = {
  visa: {
    name: 'Visa',
    logo: '/card-logos/visa.svg',
    color: '#1A1F71',
  },
  mastercard: {
    name: 'Mastercard',
    logo: '/card-logos/mastercard.svg',
    color: '#EB001B',
  },
  amex: {
    name: 'American Express',
    logo: '/card-logos/amex.svg',
    color: '#006FCF',
  },
  diners: {
    name: 'Diners Club',
    logo: '/card-logos/diners.svg',
    color: '#0079BE',
  },
  discover: {
    name: 'Discover',
    logo: '/card-logos/discover.svg',
    color: '#FF6000',
  },
  isracard: {
    name: 'Isracard',
    logo: '/card-logos/isracard.svg',
    color: '#00529B',
  },
  visaCal: {
    name: 'Visa Cal',
    logo: '/card-logos/visacal.svg',
    color: '#1A1F71',
  },
  max: {
    name: 'Max',
    logo: '/card-logos/max.svg',
    color: '#E31937',
  },
  leumi_card: {
    name: 'Leumi Card',
    logo: '/card-logos/leumi-card.svg',
    color: '#0066B3',
  },
};

// Preset account types. Free-form is still possible (stored as plain text),
// this list is just what shows up in the dropdown for the common cases.
export const ACCOUNT_TYPES = ['כרטיס אשראי', 'חשבון בנק', 'קופת גמל להשקעה', 'קרן פנסיה', 'אחר'];

interface CardData {
  last4_digits: string;
  transaction_count: number;
  card_vendor: string | null;
  card_nickname: string | null;
  account_type: string | null;
  card_vendor_id: number | null;
  card_ownership_id?: number | null;
  linked_bank_account_id?: number | null;
  bank_account_id?: number | null;
  bank_account_nickname?: string | null;
  bank_account_number?: string | null;
  bank_account_vendor?: string | null;
  custom_bank_account_number?: string | null;
  custom_bank_account_nickname?: string | null;
}

interface BankAccount {
  id: number;
  nickname: string;
  bank_account_number?: string;
  vendor: string;
}

interface CardVendorsModalProps {
  open: boolean;
  onClose: () => void;
}


const CardChip = styled(Box)({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 16px',
  borderRadius: '12px',
  background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
  color: '#fff',
  fontFamily: 'monospace',
  fontSize: '18px',
  fontWeight: 600,
  letterSpacing: '2px',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  minWidth: '140px',
});

// Component to display card vendor logo/icon
export const CardVendorIcon: React.FC<{ vendor: string | null; size?: number }> = ({
  vendor,
  size = 32
}) => {
  const theme = useTheme();
  const isBankVendor = vendor && BANK_VENDORS.includes(vendor);
  const vendorConfig = vendor ? CARD_VENDORS[vendor as keyof typeof CARD_VENDORS] : null;

  if (!vendorConfig) {
    return (
      <Box
        sx={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(148, 163, 184, 0.2)',
          borderRadius: '8px',
        }}
      >
        {isBankVendor ? (
          <AccountBalanceIcon sx={{ fontSize: size * 0.7, color: 'primary.main' }} />
        ) : (
          <CreditCardIcon sx={{ fontSize: size * 0.7, color: '#64748b' }} />
        )}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.9)' : 'white',
        borderRadius: '8px',
        padding: '4px',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- onError swaps the broken image for an inline span fallback; next/image can't model that */}
      <img
        src={vendorConfig.logo}
        alt={vendorConfig.name}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
        }}
        onError={(e) => {
          // Fallback to colored icon if image fails to load
          const target = e.target as HTMLImageElement;
          target.style.display = 'none';
          target.parentElement!.innerHTML = `<span style="color: ${vendorConfig.color}; font-weight: bold; font-size: ${size * 0.4}px">${vendorConfig.name.substring(0, 2).toUpperCase()}</span>`;
        }}
      />
    </Box>
  );
};

export default function CardVendorsModal({ open, onClose }: CardVendorsModalProps) {
  const theme = useTheme();
  const { t } = useTranslation(['misc', 'common']);
  const [cards, setCards] = useState<CardData[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{
    vendor: string;
    nickname: string;
    accountType: string;
    bankAccountId: number | null;
    customBankNumber: string;
    customBankNickname: string;
  }>({
    vendor: '',
    nickname: '',
    accountType: '',
    bankAccountId: null,
    customBankNumber: '',
    customBankNickname: ''
  });
  const [originalValues, setOriginalValues] = useState<typeof editValues | null>(null);
  const [, setIsSaving] = useState(false);
  const [_lastSaved, setLastSaved] = useState<Date | null>(null);
  const { snackbar, showSnackbar, hideSnackbar } = useSnackbar();

  const fetchCards = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/cards');
      if (!response.ok) {
        throw new Error(t('misc:cardVendors.errors.fetchCards'));
      }
      const data = await response.json();
      setCards(data);
    } catch (err) {
      showSnackbar(
        err instanceof Error ? err.message : t('misc:cardVendors.errors.generic'),
        'error'
      );
    } finally {
      setIsLoading(false);
    }
  }, [showSnackbar, t]);

  const fetchBankAccounts = useCallback(async () => {
    try {
      const response = await fetch('/api/credentials');
      if (response.ok) {
        const data = await response.json();
        const banks = data.filter((acc: { vendor: string }) =>
          ['hapoalim', 'leumi', 'mizrahi', 'discount', 'yahav', 'union', 'otsarHahayal', 'beinleumi', 'massad', 'pagi'].includes(acc.vendor)
        );
        setBankAccounts(banks);
      }
    } catch (err) {
      logger.error('Failed to fetch bank accounts', err as Error);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      fetchCards();
      fetchBankAccounts();
    });
  }, [open, fetchCards, fetchBankAccounts]);

  const handleEdit = useCallback((card: CardData, field: string = 'vendor', event?: React.MouseEvent) => {
    if (event) {
      event.stopPropagation();
    }

    if (editingCard === card.last4_digits) {
      // Just update focus within same card if needed, e.g. clicking another field
      // But autoFocus prop is only read on mount/render.
      // We might want to force re-render or let user click.
      // For now, if already editing, we rely on standard click/focus behavior.
      // We set focusedField anyway to help with render updates.
      setFocusedField(field);
      return;
    }

    if (editingCard && originalValues) {
      const hasChanges = JSON.stringify(editValues) !== JSON.stringify(originalValues);
      if (hasChanges) {
        // eslint-disable-next-line react-hooks/immutability -- handleSave is declared below; closure captures it at runtime
        handleSave(editingCard, editValues);
      }
    }

    const initialValues = {
      vendor: card.card_vendor || '',
      nickname: card.card_nickname || '',
      accountType: card.account_type || '',
      bankAccountId: card.linked_bank_account_id || ((card.custom_bank_account_number || card.custom_bank_account_nickname) ? -1 : null),
      customBankNumber: card.custom_bank_account_number || '',
      customBankNickname: card.custom_bank_account_nickname || '',
    };

    setEditingCard(card.last4_digits);
    setFocusedField(field);
    setEditValues(initialValues);
    setOriginalValues(initialValues);
    setLastSaved(null);
    setIsSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSave is declared below; depending on it would create circular deps
  }, [editingCard, editValues, originalValues]);



  const handleSave = useCallback(async (last4_digits: string, values: typeof editValues): Promise<boolean> => {
    try {
      setIsSaving(true);

      setCards(prevCards => prevCards.map(c => {
        if (c.last4_digits === last4_digits) {
          const linkedBank = bankAccounts.find(b => b.id === values.bankAccountId);

          return {
            ...c,
            card_vendor: values.vendor,
            card_nickname: values.nickname,
            account_type: values.accountType,
            linked_bank_account_id: values.bankAccountId === -1 ? null : values.bankAccountId,
            bank_account_nickname: linkedBank?.nickname || null,
            bank_account_number: linkedBank?.bank_account_number || null,
            bank_account_vendor: linkedBank?.vendor || null,
            custom_bank_account_number: values.bankAccountId === -1 ? values.customBankNumber : null,
            custom_bank_account_nickname: values.bankAccountId === -1 ? values.customBankNickname : null
          };
        }
        return c;
      }));

      setOriginalValues(values);
      setLastSaved(new Date());

      window.dispatchEvent(new CustomEvent('cardVendorsUpdated'));

      const cardResponse = await fetch('/api/cards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          last4_digits,
          card_vendor: values.vendor,
          card_nickname: values.nickname,
          account_type: values.accountType,
        }),
      });

      if (!cardResponse.ok) {
        throw new Error(t('misc:cardVendors.errors.saveCardVendor'));
      }

      const card = cards.find(c => c.last4_digits === last4_digits);

      {
        // No ownership row yet -> let the API create one from the card's last 4 digits
        const ownershipId = card?.card_ownership_id ?? `last4:${last4_digits}`;
        const payload: Record<string, unknown> = {};

        if (values.bankAccountId === -1) {
          if (!values.customBankNumber?.trim() && !values.customBankNickname?.trim()) {
            throw new Error(t('misc:cardVendors.errors.customAccountRequired'));
          }
          payload.custom_bank_account_number = values.customBankNumber;
          payload.custom_bank_account_nickname = values.customBankNickname;
          payload.linked_bank_account_id = null;
        } else {
          payload.linked_bank_account_id = values.bankAccountId;
          payload.custom_bank_account_number = null;
          payload.custom_bank_account_nickname = null;
        }

        const bankResponse = await fetch(`/api/cards/ownerships/${ownershipId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!bankResponse.ok) {
          throw new Error(t('misc:cardVendors.errors.updateBankAccount'));
        }
      }

      return true;
    } catch (err) {
      showSnackbar(
        err instanceof Error ? err.message : t('misc:cardVendors.errors.saveFailed'),
        'error'
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [bankAccounts, cards, showSnackbar, t]);

  useEffect(() => {
    if (!editingCard || !originalValues) return;
    const hasChanges = JSON.stringify(editValues) !== JSON.stringify(originalValues);
    if (!hasChanges) return;

    const timeoutId = setTimeout(() => {
      handleSave(editingCard, editValues);
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [editValues, editingCard, originalValues, handleSave]);

  const columns = React.useMemo(() => [
    {
      id: 'card',
      label: t('misc:cardVendors.columns.card'),
      format: (_: unknown, card: CardData) => (
        <CardChip>
          <CardVendorIcon vendor={card.card_vendor} size={28} />
          •••• {card.last4_digits}
        </CardChip>
      )
    },
    {
      id: 'transactions',
      label: t('misc:cardVendors.columns.transactions'),
      format: (_: unknown, card: CardData) => (
        <Typography
          sx={{
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            color: 'var(--n-primary-500)',
            padding: '4px 12px',
            borderRadius: '20px',
            fontSize: '14px',
            fontWeight: 500,
            display: 'inline-block',
          }}
        >
          {card.transaction_count.toLocaleString()}
        </Typography>
      )
    },
    {
      id: 'nickname',
      label: t('misc:cardVendors.columns.nickname'),
      format: (_: unknown, card: CardData) => editingCard === card.last4_digits ? (
        <TextField
          key={`nickname-edit-${card.last4_digits}`}
          className={`edit-group-${card.last4_digits}`}
          size="small"
          autoFocus={focusedField === 'nickname'}
          value={editValues.nickname}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEditValues(prev => ({ ...prev, nickname: e.target.value }))}
          onBlur={(e) => {
            if (e.relatedTarget && (e.relatedTarget as Element).closest(`.edit-group-${card.last4_digits}`)) {
              return;
            }
            if (JSON.stringify(editValues) !== JSON.stringify(originalValues)) {
              handleSave(editingCard, editValues).then((success) => {
                if (success) {
                  setEditingCard(null);
                  showSnackbar(t('misc:cardVendors.snackbar.nicknameSaved'), 'success');
                }
              });
            } else {
              setEditingCard(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLElement).blur();
            }
          }}
          placeholder={t('misc:cardVendors.nicknamePlaceholder')}
          fullWidth
          sx={{
            '& .MuiOutlinedInput-root': {
              borderRadius: '12px',
            },
          }}
        />
      ) : (
        <Typography
          sx={{
            color: card.card_nickname ? theme.palette.text.primary : theme.palette.text.disabled,
            fontStyle: card.card_nickname ? 'normal' : 'italic',
            cursor: 'pointer',
            padding: '8px 12px',
            borderRadius: '12px',
            '&:hover': {
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
            }
          }}
          onClick={(e) => handleEdit(card, 'nickname', e)}
        >
          {card.card_nickname || t('misc:cardVendors.noNickname')}
        </Typography>
      )
    },
    {
      id: 'accountType',
      label: t('misc:cardVendors.columns.accountType'),
      minWidth: '160px',
      format: (_: unknown, card: CardData) => editingCard === card.last4_digits ? (
        <TextField
          key={`type-edit-${card.last4_digits}`}
          className={`edit-group-${card.last4_digits}`}
          select
          size="small"
          autoFocus={focusedField === 'accountType'}
          value={editValues.accountType}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const newValue = e.target.value;
            setEditValues(prev => ({ ...prev, accountType: newValue }));

            const newValues = { ...editValues, accountType: newValue };
            if (JSON.stringify(newValues) !== JSON.stringify(originalValues)) {
              setTimeout(() => {
                handleSave(editingCard, newValues).then((success) => {
                  if (success) {
                    setEditingCard(null);
                    showSnackbar(t('misc:cardVendors.snackbar.accountTypeUpdated'), 'success');
                  }
                });
              }, 200);
            } else {
              setEditingCard(null);
            }
          }}
          fullWidth
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: '12px' } }}
          slotProps={{ select: { defaultOpen: focusedField === 'accountType' } }}
        >
          <MenuItem value="">
            <em>{t('misc:cardVendors.accountTypeNone')}</em>
          </MenuItem>
          {ACCOUNT_TYPES.map((typeLabel) => (
            <MenuItem key={typeLabel} value={typeLabel}>{typeLabel}</MenuItem>
          ))}
        </TextField>
      ) : (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            padding: '8px 12px',
            borderRadius: '12px',
            transition: 'all 0.2s',
            '&:hover': { backgroundColor: 'rgba(59, 130, 246, 0.1)' },
          }}
          onClick={(e) => handleEdit(card, 'accountType', e)}
        >
          <Typography sx={{ color: card.account_type ? theme.palette.text.primary : theme.palette.text.disabled, fontStyle: card.account_type ? 'normal' : 'italic' }}>
            {card.account_type || t('misc:cardVendors.accountTypeNone')}
          </Typography>
        </Box>
      )
    },
  ], [editingCard, editValues, originalValues, theme, focusedField, t, handleEdit, handleSave, showSnackbar]);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="xl"
        fullWidth
        slotProps={{
          backdrop: {
            style: {
              backgroundColor: 'rgba(0, 0, 0, 0.4)',
              backdropFilter: 'blur(8px)',
            },
          },

          paper: {
            style: {
              background: theme.palette.mode === 'dark'
                ? `linear-gradient(135deg, ${alpha(theme.palette.background.paper, 0.98)} 0%, ${alpha(theme.palette.background.default, 0.98)} 100%)`
                : 'linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.98) 100%)',
              backdropFilter: 'blur(20px)',
              borderRadius: '28px',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.15)',
              border: `1px solid ${theme.palette.divider}`,
              maxWidth: '1200px',
            },
          }
        }}>
        <ModalHeader title={t('misc:cardVendors.title')} onClose={onClose} />
        <DialogContent style={{ padding: '0 32px 32px', color: theme.palette.text.primary }}>
          <Typography variant="body2" sx={{ mb: 3, color: theme.palette.text.secondary }}>
            {t('misc:cardVendors.subtitle')}
          </Typography>

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
              {t('misc:cardVendors.loading')}
            </Box>
          ) : cards.length === 0 ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px', color: theme.palette.text.secondary }}>
              {t('misc:cardVendors.emptyState')}
            </Box>
          ) : (
            <Box
              sx={{
                borderRadius: '20px',
                overflow: 'hidden',
                border: `1px solid ${theme.palette.divider}`,
                boxShadow: '0 2px 12px rgba(0, 0, 0, 0.04)',
                background: theme.palette.mode === 'dark'
                  ? `linear-gradient(135deg, ${alpha(theme.palette.background.paper, 0.95)} 0%, ${alpha(theme.palette.background.default, 0.95)} 100%)`
                  : 'linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(248, 250, 252, 0.95) 100%)',
                backdropFilter: 'blur(10px)',
              }}
            >
              <Table
                rows={cards}
                rowKey={(card) => card.last4_digits}
                emptyMessage={t('misc:cardVendors.emptyTableMessage')}
                columns={columns}
                mobileCardRenderer={(card: CardData) => (
                  <Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <CardChip sx={{ padding: '4px 12px', fontSize: '14px', minWidth: 'auto' }}>
                        <CardVendorIcon vendor={card.card_vendor} size={20} />
                        •••• {card.last4_digits}
                      </CardChip>
                      <Typography
                        sx={{
                          backgroundColor: 'rgba(99, 102, 241, 0.1)',
                          color: 'var(--n-primary-500)',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '12px',
                          fontWeight: 500,
                        }}
                      >
                        {t('misc:cardVendors.transactionsCount', { count: card.transaction_count })}
                      </Typography>
                    </Box>
                    <Box sx={{ mb: 2 }}>
                      <Typography
                        variant="body2"
                        sx={{
                          color: card.card_nickname ? theme.palette.text.primary : theme.palette.text.disabled,
                          fontStyle: card.card_nickname ? 'normal' : 'italic',
                          cursor: 'pointer',
                          mb: 1
                        }}
                        onClick={() => handleEdit(card)}
                      >
                        {card.card_nickname || t('misc:cardVendors.noNicknameSet')}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: card.account_type ? theme.palette.text.primary : theme.palette.text.disabled,
                          fontStyle: card.account_type ? 'normal' : 'italic',
                          display: 'block',
                          cursor: 'pointer'
                        }}
                        onClick={() => handleEdit(card)}
                      >
                        {card.account_type || t('misc:cardVendors.accountTypeNone')}
                      </Typography>
                    </Box>

                    {editingCard === card.last4_digits && (
                      <Box sx={{ borderTop: `1px solid ${theme.palette.divider}`, pt: 2, mt: 2 }}>
                        {/* Re-use edit fields for mobile if needed, or just show a message to use desktop */}
                        <Typography variant="caption" sx={{
                          color: "warning.main"
                        }}>{t('misc:cardVendors.editingDesktopHint')}</Typography>
                      </Box>
                    )}
                  </Box>
                )}
              />
            </Box >
          )
          }
        </DialogContent >
      </Dialog >
      <SnackbarFeedback
        snackbar={snackbar}
        onClose={hideSnackbar}
        autoHideDuration={4000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        alertSx={{
          width: '100%',
          borderRadius: '12px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
        }}
      />
    </>
  );
}
