
import { createTheme, ThemeOptions } from '@mui/material/styles';

type Mode = 'light' | 'dark';
type Direction = 'ltr' | 'rtl';

// Common settings
const baseTheme: ThemeOptions = {
    typography: {
        fontFamily: "'Outfit', 'Assistant', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
        h1: { fontWeight: 800, letterSpacing: '-0.025em' },
        h2: { fontWeight: 700, letterSpacing: '-0.02em' },
        h3: { fontWeight: 700, letterSpacing: '-0.015em' },
        h4: { fontWeight: 700, letterSpacing: '-0.01em' },
        h5: { fontWeight: 600 },
        h6: { fontWeight: 600 },
        button: { textTransform: 'none', fontWeight: 600, letterSpacing: '0.01em' },
    },
    shape: {
        borderRadius: 12,
    },
    components: {
        MuiButton: {
            styleOverrides: {
                root: {
                    borderRadius: 10,
                    boxShadow: 'none',
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    '&:hover': {
                        transform: 'translateY(-1px)',
                        boxShadow: 'var(--n-shadow-md)',
                    },
                    '&:active': {
                        transform: 'translateY(0)',
                    },
                    '&.MuiButton-containedPrimary': {
                        background: 'var(--n-gradient-primary)',
                        '&:hover': {
                            background: 'var(--n-gradient-primary)',
                            filter: 'brightness(1.08)',
                            boxShadow: 'var(--n-shadow-glow)',
                        },
                    },
                },
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    backgroundImage: 'none',
                    borderRadius: 16,
                    border: '1px solid var(--n-border)',
                    backgroundColor: 'var(--n-bg-surface)',
                    boxShadow: 'var(--n-shadow-sm)',
                    transition: 'all 0.3s ease',
                    '&:hover': {
                        boxShadow: 'var(--n-shadow-lg)',
                        borderColor: 'var(--n-border-hover)',
                    },
                },
            },
        },
        MuiPaper: {
            styleOverrides: {
                root: {
                    backgroundImage: 'none',
                    backgroundColor: 'var(--n-bg-surface)',
                },
            },
        },
        MuiOutlinedInput: {
            styleOverrides: {
                root: {
                    borderRadius: 10,
                    '&:hover .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'var(--n-border-hover)',
                    },
                    '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                        borderWidth: 1,
                        boxShadow: '0 0 0 3px rgb(99 102 241 / 0.15)',
                    },
                },
                notchedOutline: {
                    borderColor: 'var(--n-border)',
                    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                },
            },
        },
        MuiChip: {
            styleOverrides: {
                root: {
                    borderRadius: 8,
                    fontWeight: 600,
                },
            },
        },
        MuiTooltip: {
            styleOverrides: {
                tooltip: {
                    borderRadius: 8,
                    fontWeight: 500,
                    fontSize: '0.75rem',
                    padding: '6px 10px',
                    backgroundColor: 'var(--n-zinc-800)',
                    boxShadow: 'var(--n-shadow-md)',
                },
                arrow: {
                    color: 'var(--n-zinc-800)',
                },
            },
        },
        MuiMenu: {
            styleOverrides: {
                paper: {
                    borderRadius: 12,
                    border: '1px solid var(--n-border)',
                    boxShadow: 'var(--n-shadow-lg)',
                    marginTop: 4,
                },
                list: {
                    padding: 6,
                },
            },
        },
        MuiMenuItem: {
            styleOverrides: {
                root: {
                    borderRadius: 8,
                    margin: '1px 0',
                    transition: 'background-color 0.15s ease',
                },
            },
        },
        MuiTab: {
            styleOverrides: {
                root: {
                    textTransform: 'none',
                    fontWeight: 600,
                },
            },
        },
        MuiLinearProgress: {
            styleOverrides: {
                root: {
                    borderRadius: 9999,
                },
                bar: {
                    borderRadius: 9999,
                },
            },
        },
        MuiTableCell: {
            styleOverrides: {
                root: {
                    borderBottom: '1px solid var(--n-border)',
                },
                head: {
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    backgroundColor: 'var(--n-bg-surface-alt)',
                    color: 'var(--n-text-secondary)',
                },
            },
        },
        MuiDialog: {
            styleOverrides: {
                paper: {
                    borderRadius: 20,
                    boxShadow: 'var(--n-shadow-xl)',
                    border: '1px solid var(--n-border)',
                },
            },
        },
        MuiBackdrop: {
            styleOverrides: {
                root: {
                    backgroundColor: 'rgba(14, 14, 22, 0.55)',
                    backdropFilter: 'blur(4px)',
                    '&.MuiBackdrop-invisible': {
                        backgroundColor: 'transparent',
                        backdropFilter: 'none',
                    },
                },
            },
        },
    },
};

const lightPalette: ThemeOptions['palette'] = {
    mode: 'light',
    primary: {
        main: '#6366f1',
        light: '#818cf8',
        dark: '#4f46e5',
    },
    secondary: {
        main: '#70708c',
        light: '#9c9cb4',
        dark: '#52526d',
    },
    background: {
        default: '#f8f8fc',
        paper: '#ffffff',
    },
    text: {
        primary: '#171722',
        secondary: '#52526d',
    },
    divider: '#e2e2ec',
};

const darkPalette: ThemeOptions['palette'] = {
    mode: 'dark',
    primary: {
        main: '#818cf8',
        light: '#a5b4fc',
        dark: '#6366f1',
    },
    secondary: {
        main: '#9c9cb4',
        light: '#cdcdde',
        dark: '#70708c',
    },
    background: {
        default: '#0e0e16',
        paper: '#171722',
    },
    text: {
        primary: '#f8f8fc',
        secondary: '#9c9cb4',
    },
    divider: '#232333',
};

export const buildTheme = (mode: Mode, direction: Direction = 'ltr') =>
    createTheme({
        ...baseTheme,
        direction,
        palette: mode === 'light' ? lightPalette : darkPalette,
    });

export const lightTheme = buildTheme('light');
export const darkTheme = buildTheme('dark');
