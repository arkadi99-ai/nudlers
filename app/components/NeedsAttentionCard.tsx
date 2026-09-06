import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, TextField, Autocomplete, Button } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/Help';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
import { useCategories } from './CategoryDashboard/utils/useCategories';

interface NeedsAttentionItem {
    description: string;
    total: number;
    count: number;
    lastDate: string;
    currentCategory: string | null;
}

const NeedsAttentionCard: React.FC = () => {
    const { t } = useTranslation('views');
    const { locale } = useLocale();
    const dateLocale = locale === 'he' ? 'he-IL' : 'en-US';
    const { categories: availableCategories } = useCategories();

    const [items, setItems] = useState<NeedsAttentionItem[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [categoryInput, setCategoryInput] = useState('');

    const fetchItems = useCallback(async () => {
        try {
            const res = await fetch('/api/reports/needs-attention');
            const result = await res.json();
            setItems(result.items || []);
        } catch (err) {
            console.error('Failed to fetch needs-attention items', err);
        }
    }, []);

    useEffect(() => {
        queueMicrotask(() => fetchItems());
        const handler = () => fetchItems();
        window.addEventListener('dataRefresh', handler);
        return () => window.removeEventListener('dataRefresh', handler);
    }, [fetchItems]);

    const formatCurrency = (amount: number) =>
        new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(amount);

    const saveCategory = async (description: string) => {
        if (!categoryInput.trim()) return;
        try {
            const res = await fetch('/api/categories/update-by-description', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description,
                    newCategory: categoryInput.trim(),
                    createRule: true,
                }),
            });
            if (res.ok) {
                setItems(prev => prev.filter(i => i.description !== description));
                window.dispatchEvent(new CustomEvent('dataRefresh'));
            }
        } catch (err) {
            console.error('Failed to update category', err);
        } finally {
            setEditing(null);
            setCategoryInput('');
        }
    };

    if (items.length === 0) return null;

    return (
        <Box
            className="n-card n-glass"
            sx={{
                margin: { xs: '12px 4px', md: '0 16px 24px' },
                padding: { xs: '16px', md: '24px' },
                borderRadius: '24px',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <HelpOutlineIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                    {t('summary.needsAttention.title')}
                </Typography>
            </Box>
            <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mb: 2 }}>
                {t('summary.needsAttention.subtitle')}
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                {items.map(item => (
                    <Box
                        key={item.description}
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 2,
                            flexWrap: 'wrap',
                            py: 1,
                            borderBottom: '1px solid var(--n-border)',
                        }}
                    >
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography sx={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {item.description}
                            </Typography>
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                                {t('summary.needsAttention.occurrences', { count: item.count, amount: formatCurrency(item.total) })}
                            </Typography>
                        </Box>

                        {editing === item.description ? (
                            <Autocomplete
                                freeSolo
                                size="small"
                                options={availableCategories}
                                inputValue={categoryInput}
                                onInputChange={(_, val) => setCategoryInput(val)}
                                onChange={(_, val) => setCategoryInput(val || '')}
                                sx={{ width: 200 }}
                                renderInput={(params) => (
                                    <TextField
                                        {...params}
                                        autoFocus
                                        placeholder={t('summary.needsAttention.categoryPlaceholder') as string}
                                        onKeyDown={(e) => { if (e.key === 'Enter') saveCategory(item.description); }}
                                        onBlur={() => saveCategory(item.description)}
                                    />
                                )}
                            />
                        ) : (
                            <Button size="small" variant="outlined" onClick={() => { setEditing(item.description); setCategoryInput(''); }}>
                                {t('summary.needsAttention.categorize')}
                            </Button>
                        )}
                    </Box>
                ))}
            </Box>
        </Box>
    );
};

export default NeedsAttentionCard;
