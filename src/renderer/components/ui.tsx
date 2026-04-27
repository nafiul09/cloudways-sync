// Custom UI components that replicate @getflywheel/local-components styling.
// Built for Local WP's dark-theme Electron renderer environment.
// Colors, spacing, and typography match the local-components library exactly.

import React, { useState, useEffect, useRef } from 'react';

// ─── Color Palette (Local Dark Theme) ────────────────────────────────────────
const C = {
  white: '#ffffff',
  gray15: '#e7e7e7',
  gray25: '#c7c4c4',
  gray75: '#9f9c9c',
  gray: '#5d5e5e',
  grayDark50: '#434344',
  grayDark: '#262727',
  grayDarkAlt: '#303031',
  green: '#51bb7b',
  greenDark: '#267048',
  greenDark50: '#419564',
  green15: '#D8F0DE',
  red: '#ef4e65',
  redDark: '#8c2738',
  redDark50: '#ba3e51',
  red15: '#FFE2DF',
  orange: '#f47820',
  orangeDark: '#8e4402',
};

// ─── Banner Icons ────────────────────────────────────────────────────────────

// Info circle (neutral) — 18x18
function InfoIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill={C.white}
        d="M9 16C12.866 16 16 12.866 16 9C16 5.13401 12.866 2 9 2C5.13403 2 2 5.13401 2 9C2 12.866 5.13403 16 9 16ZM9 18C13.9705 18 18 13.9706 18 9C18 4.02943 13.9705 0 9 0C4.02954 0 0 4.02943 0 9C0 13.9706 4.02954 18 9 18ZM7.875 8C7.32275 8 6.875 8.44772 6.875 9C6.875 9.55228 7.32275 10 7.875 10H8V12.9375C8 13.4898 8.44775 13.9375 9 13.9375C9.55225 13.9375 10 13.4898 10 12.9375V9C10 8.44772 9.55225 8 9 8H7.875ZM9 6.75C9.62134 6.75 10.125 6.24632 10.125 5.625C10.125 5.00368 9.62134 4.5 9 4.5C8.37866 4.5 7.875 5.00368 7.875 5.625C7.875 6.24632 8.37866 6.75 9 6.75Z"
      />
    </svg>
  );
}

// Checkmark circle (success) — 18x18
function SuccessIcon(): React.ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill={C.white}
        d="M16 9C16 12.866 12.866 16 9 16C5.13401 16 2 12.866 2 9C2 5.13401 5.13401 2 9 2C12.866 2 16 5.13401 16 9ZM18 9C18 13.9706 13.9706 18 9 18C4.02944 18 0 13.9706 0 9C0 4.02944 4.02944 0 9 0C13.9706 0 18 4.02944 18 9ZM5.03032 10.0946L7.29289 12.3571C7.68342 12.7477 8.31658 12.7477 8.70711 12.3571L13.3033 7.76094C13.6938 7.37041 13.6938 6.73725 13.3033 6.34672C12.9128 5.9562 12.2796 5.9562 11.8891 6.34672L8 10.2358L6.44453 8.68034C6.05401 8.28982 5.42084 8.28982 5.03032 8.68034C4.6398 9.07087 4.6398 9.70403 5.03032 10.0946Z"
      />
    </svg>
  );
}

// Warning/error triangle — 21x18
function YieldIcon(): React.ReactElement {
  return (
    <svg width="21" height="18" viewBox="0 0 21 18" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill={C.white}
        d="M18.8348 10.9877L13.4981 2.68623L13.4408 2.59696L13.4408 2.59693C13.1135 2.08739 12.7582 1.53413 12.4008 1.12536C11.9993 0.666244 11.2645 0 10.1334 0C9.00227 0 8.26756 0.666245 7.86606 1.12536C7.50859 1.53414 7.15327 2.08742 6.82603 2.59698L6.76869 2.68623L1.43203 10.9877L1.36967 11.0847L1.36966 11.0847C0.987648 11.6784 0.589021 12.298 0.343794 12.8408C0.0823667 13.4194 -0.271713 14.4826 0.331937 15.5883C0.935587 16.694 2.0214 16.9711 2.6495 17.0641C3.23868 17.1513 3.97543 17.151 4.68147 17.1508L4.79674 17.1507H15.4701L15.5854 17.1508C16.2914 17.151 17.0281 17.1513 17.6173 17.0641C18.2454 16.9711 19.3312 16.694 19.9349 15.5883C20.5385 14.4826 20.1844 13.4194 19.923 12.8408C19.6778 12.298 19.2792 11.6784 18.8972 11.0847L18.8348 10.9877ZM17.1524 12.0692L11.8158 3.76774C11.0582 2.58925 10.6794 2 10.1334 2C9.58746 2 9.20865 2.58925 8.45105 3.76774L3.11438 12.0692C2.24014 13.4292 1.80302 14.1091 2.08736 14.6299C2.3717 15.1507 3.18005 15.1507 4.79674 15.1507H15.4701C17.0868 15.1507 17.8951 15.1507 18.1795 14.6299C18.4638 14.1091 18.0267 13.4292 17.1524 12.0692ZM10.2584 10.8108C9.70612 10.8108 9.25841 10.3631 9.25841 9.81078V5.81078C9.25841 5.25849 9.70612 4.81078 10.2584 4.81078C10.8107 4.81078 11.2584 5.25849 11.2584 5.81078V9.81078C11.2584 10.3631 10.8107 10.8108 10.2584 10.8108ZM9.13341 12.7458C9.13341 12.1245 9.63709 11.6208 10.2584 11.6208C10.8797 11.6208 11.3834 12.1245 11.3834 12.7458C11.3834 13.3671 10.8797 13.8708 10.2584 13.8708C9.63709 13.8708 9.13341 13.3671 9.13341 12.7458Z"
      />
    </svg>
  );
}

// ─── Banner ──────────────────────────────────────────────────────────────────

type BannerVariant = 'error' | 'success' | 'warning' | 'neutral';

// stripe1 = primary stripe color, stripe2 = secondary stripe color (lighter mix)
const bannerColors: Record<BannerVariant, {
  bg: string; stripe1: string; stripe2: string; text: string;
}> = {
  neutral: {
    bg: C.gray15,
    stripe1: C.grayDark50,
    stripe2: '#454546', // mix(gray1, grayDark50, 5%)
    text: C.grayDark,
  },
  error: {
    bg: C.red15,
    stripe1: C.red,
    stripe2: '#e8546a', // mix(gray1, red, 13%)
    text: C.redDark,
  },
  warning: {
    bg: C.red15,
    stripe1: C.red,
    stripe2: '#e8546a',
    text: C.redDark,
  },
  success: {
    bg: C.green15,
    stripe1: C.green,
    stripe2: '#5bbe82', // mix(gray1, green, 13%)
    text: C.greenDark,
  },
};

type BannerProps = {
  variant?: BannerVariant;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

export function Banner({
  variant = 'neutral',
  children,
  className,
  style,
}: BannerProps): React.ReactElement {
  const colors = bannerColors[variant];

  const icon = (() => {
    switch (variant) {
      case 'error':
      case 'warning':
        return <YieldIcon />;
      case 'success':
        return <SuccessIcon />;
      case 'neutral':
      default:
        return <InfoIcon />;
    }
  })();

  const base: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: colors.bg,
    borderRadius: 4,
    padding: 0,
    overflow: 'hidden',
    color: colors.text,
    fontSize: '1.4rem',
    lineHeight: 1.5,
    width: '100%',
    boxShadow: `inset 0px -10px 10px -10px rgba(0,0,0,0.06)`,
    ...style,
  };

  const iconWrapperStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    padding: 15,
    flexShrink: 0,
    background: `repeating-linear-gradient(110deg, ${colors.stripe1}, ${colors.stripe1} 15px, ${colors.stripe2} 15px, ${colors.stripe2} 30px)`,
  };

  return (
    <div className={className} style={base} role="status">
      <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', flex: 1, minWidth: 0 }}>
        <div style={iconWrapperStyle}>{icon}</div>
        <span style={{ padding: 15, flex: 1, minWidth: 0 }}>{children}</span>
      </div>
    </div>
  );
}

// ─── Button ──────────────────────────────────────────────────────────────────

type ButtonProps = {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  type?: 'button' | 'submit' | 'reset';
};

export function Button({
  onClick,
  disabled,
  children,
  className,
  style,
  type = 'button',
}: ButtonProps): React.ReactElement {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  // Green outline button (dark theme): green border + green text,
  // hover fills green bg + white text, active fills darker green.
  const isHover = hover && !disabled;
  const isActive = active && !disabled;

  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    gap: 6,
    padding: '10px 20px',
    fontSize: '1.4rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    lineHeight: 1.3,
    borderRadius: 500,
    border: 'none',
    background: isActive ? C.greenDark50 : isHover ? C.green : 'transparent',
    color: disabled ? C.gray75 : (isHover || isActive) ? C.white : C.green,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'transform 0.1s ease, background 0.1s ease, color 0.1s ease',
    transform: isActive ? 'scale(0.98)' : 'none',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    ...style,
  };

  // ::after pseudo-element for the 2px border (matches library pattern)
  const afterStyle: React.CSSProperties = {
    content: '""',
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    border: `2px solid ${disabled ? C.gray75 : (isHover || isActive) ? 'transparent' : C.green}`,
    borderRadius: 500,
    transition: 'border 0.1s ease',
    pointerEvents: 'none',
  };

  return (
    <button
      type={type}
      className={className}
      style={base}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
    >
      {children}
      <span style={afterStyle} aria-hidden />
    </button>
  );
}

// ─── PrimaryButton ───────────────────────────────────────────────────────────

export function PrimaryButton({
  onClick,
  disabled,
  children,
  className,
  style,
  type = 'button',
}: ButtonProps): React.ReactElement {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  // Green fill button (dark theme): white bg + dark text default,
  // green bg + white text on hover, darker green on active.
  const isHover = hover && !disabled;
  const isActive = active && !disabled;

  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    gap: 6,
    padding: '20px 30px',
    fontSize: '1.4rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    lineHeight: 1.3,
    borderRadius: 500,
    border: 'none',
    background: disabled ? C.gray75 : isActive ? C.greenDark50 : isHover ? C.green : C.white,
    color: disabled ? C.gray : (isHover || isActive) ? C.white : C.grayDark,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'transform 0.1s ease, background 0.1s ease, color 0.1s ease',
    transform: isActive ? 'scale(0.98)' : 'none',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    ...style,
  };
  return (
    <button
      type={type}
      className={className}
      style={base}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
    >
      {children}
    </button>
  );
}

// ─── TextButton ──────────────────────────────────────────────────────────────

export function TextButton({
  onClick,
  disabled,
  children,
  className,
  style,
}: ButtonProps): React.ReactElement {
  const [hover, setHover] = useState(false);
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    fontSize: '1.4rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    lineHeight: 1.3,
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    color: hover && !disabled ? C.greenDark50 : C.green,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'color 0.15s',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    ...style,
  };
  return (
    <button
      type="button"
      className={className}
      style={base}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </button>
  );
}

// ─── Text ────────────────────────────────────────────────────────────────────

type TextProps = {
  size?: 'default' | 'caption';
  tag?: keyof JSX.IntrinsicElements;
  children?: React.ReactNode;
  className?: string;
  id?: string;
  style?: React.CSSProperties;
};

export function Text({
  size = 'default',
  tag,
  children,
  className,
  id,
  style,
}: TextProps): React.ReactElement {
  const Tag = (tag || 'span') as any;
  const base: React.CSSProperties = {
    fontSize: '1.4rem',
    fontWeight: 300,
    lineHeight: 1.5,
    color: size === 'caption' ? C.gray25 : C.gray15,
    ...style,
  };
  return (
    <Tag className={className} id={id} style={base}>
      {children}
    </Tag>
  );
}

// ─── Title ───────────────────────────────────────────────────────────────────

type TitleSize = 'caption' | 's' | 'm' | 'l' | 'xl';

const titleFontSizes: Record<TitleSize, string> = {
  caption: '1.4rem',
  s: '1.4rem',
  m: '1.8rem',
  l: '2.4rem',
  xl: '4.2rem',
};

type TitleProps = {
  size?: TitleSize;
  tag?: keyof JSX.IntrinsicElements;
  children?: React.ReactNode;
  className?: string;
  id?: string;
  style?: React.CSSProperties;
};

export function Title({
  size = 'm',
  tag,
  children,
  className,
  id,
  style,
}: TitleProps): React.ReactElement {
  const Tag = (tag || 'div') as any;
  const base: React.CSSProperties = {
    fontSize: titleFontSizes[size],
    fontWeight: 700,
    lineHeight: 1.3,
    color: C.white,
    margin: 0,
    ...style,
  };
  return (
    <Tag className={className} id={id} style={base}>
      {children}
    </Tag>
  );
}

// ─── BasicInput ──────────────────────────────────────────────────────────────

type BasicInputProps = {
  id?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  type?: string;
};

export function BasicInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  className,
  style,
  type = 'text',
}: BasicInputProps): React.ReactElement {
  const [focused, setFocused] = useState(false);
  const inputStyle: React.CSSProperties = {
    appearance: 'none',
    WebkitAppearance: 'none',
    width: '100%',
    padding: '12px 16px',
    fontSize: '1.4rem',
    fontFamily: 'inherit',
    fontWeight: 400,
    lineHeight: 1.4,
    color: C.white,
    background: C.grayDark,
    border: 'none',
    borderRadius: 4,
    boxShadow: focused
      ? `inset 0 0 0 2px ${C.green}`
      : `inset 0 0 0 1px ${C.grayDark50}`,
    outline: 'none',
    boxSizing: 'border-box' as const,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'text',
    transition: 'box-shadow 0.15s',
    ...style,
  };
  return (
    <div className={className}>
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        style={inputStyle}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  );
}

// ─── InputPasswordToggle ─────────────────────────────────────────────────────

type InputPasswordToggleProps = {
  id?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export function InputPasswordToggle({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  className,
  style,
}: InputPasswordToggleProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapStyle: React.CSSProperties = {
    position: 'relative' as const,
    ...style,
  };
  const inputStyle: React.CSSProperties = {
    appearance: 'none',
    WebkitAppearance: 'none',
    width: '100%',
    padding: '12px 44px 12px 16px',
    fontSize: '1.4rem',
    fontFamily: 'inherit',
    fontWeight: 400,
    lineHeight: 1.4,
    color: C.white,
    background: C.grayDark,
    border: 'none',
    borderRadius: 4,
    boxShadow: focused
      ? `inset 0 0 0 2px ${C.green}`
      : `inset 0 0 0 1px ${C.grayDark50}`,
    outline: 'none',
    boxSizing: 'border-box' as const,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'text',
    transition: 'box-shadow 0.15s',
  };
  const eyeStyle: React.CSSProperties = {
    position: 'absolute' as const,
    top: '50%',
    right: 13,
    transform: 'translateY(-50%)',
    width: 20,
    height: 20,
    cursor: 'pointer',
    opacity: 0.7,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  return (
    <div className={className} style={wrapStyle}>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        style={inputStyle}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      <span
        style={eyeStyle}
        onClick={() => setVisible(!visible)}
        role="button"
        tabIndex={0}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke={visible ? C.green : C.gray25}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {visible ? (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </>
          ) : (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
              <path d="M14.12 14.12a3 3 0 01-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </>
          )}
        </svg>
      </span>
    </div>
  );
}

// ─── Checkbox ────────────────────────────────────────────────────────────────

type CheckboxProps = {
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label?: string;
  disabled?: boolean;
  name?: string;
  className?: string;
  id?: string;
  style?: React.CSSProperties;
};

export function Checkbox({
  checked = false,
  onChange,
  label,
  disabled,
  name,
  className,
  id,
  style,
}: CheckboxProps): React.ReactElement {
  const [hover, setHover] = useState(false);
  const boxStyle: React.CSSProperties = {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: `2px solid ${
      checked ? C.green : hover ? C.gray25 : C.gray75
    }`,
    background: checked ? C.green : 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'border-color 0.15s, background 0.15s',
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
  const labelStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '1.4rem',
    fontWeight: 500,
    color: C.white,
    opacity: disabled ? 0.7 : 1,
    ...style,
  };
  return (
    <label
      className={className}
      id={id}
      style={labelStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
      />
      <span style={boxStyle}>
        {checked && (
          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
            <path
              d="M1 5.5L4 8.5L11 1.5"
              stroke={C.white}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

// ─── FlySelect ───────────────────────────────────────────────────────────────

type FlySelectOption = { label: string; value: string };

type FlySelectProps = {
  id?: string;
  value?: string;
  onChange: (value: string) => void;
  options?: FlySelectOption[] | string[] | Record<string, string>;
  placeholder?: string;
  emptyPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export function FlySelect({
  id,
  value,
  onChange,
  options = [],
  placeholder,
  emptyPlaceholder,
  disabled,
  className,
  style,
}: FlySelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Normalize options to { label, value } objects
  const normalized: FlySelectOption[] = Array.isArray(options)
    ? options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o))
    : Object.entries(options).map(([value, label]) => ({ value, label }));

  const selectedLabel = normalized.find((o) => o.value === value)?.label;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const wrapStyle: React.CSSProperties = {
    position: 'relative' as const,
    width: '100%',
    ...style,
  };

  const triggerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '12px 36px 12px 16px',
    fontSize: '1.4rem',
    fontFamily: 'inherit',
    fontWeight: 400,
    lineHeight: 1.4,
    color: selectedLabel ? C.white : C.gray75,
    background: C.grayDark,
    border: 'none',
    borderRadius: 4,
    boxShadow: focused || open
      ? `inset 0 0 0 2px ${C.green}`
      : `inset 0 0 0 1px ${C.grayDark50}`,
    outline: 'none',
    boxSizing: 'border-box' as const,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'box-shadow 0.15s',
    textAlign: 'left' as const,
  };

  const caretStyle: React.CSSProperties = {
    position: 'absolute' as const,
    right: 14,
    top: '50%',
    transform: `translateY(-50%) rotate(${open ? '180deg' : '0deg'})`,
    width: 0,
    height: 0,
    borderLeft: '5px solid transparent',
    borderRight: '5px solid transparent',
    borderTop: `6px solid ${C.green}`,
    transition: 'transform 0.15s',
    pointerEvents: 'none' as const,
  };

  const dropStyle: React.CSSProperties = {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    background: C.grayDark,
    border: `1px solid ${C.grayDark50}`,
    borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    zIndex: 1000,
    maxHeight: 220,
    overflowY: 'auto' as const,
  };

  const showEmpty = normalized.length === 0;

  return (
    <div ref={ref} className={className} id={id} style={wrapStyle}>
      <button
        type="button"
        style={triggerStyle}
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {selectedLabel || placeholder || 'Select…'}
      </button>
      <div style={caretStyle} />
      {open && (
        <div style={dropStyle}>
          {showEmpty ? (
            <div style={{ padding: '12px 16px', color: C.gray75, fontSize: '1.4rem' }}>
              {emptyPlaceholder || 'No options'}
            </div>
          ) : (
            normalized.map((opt, i) => (
              <FlySelectItem
                key={opt.value}
                option={opt}
                selected={opt.value === value}
                striped={i % 2 === 1}
                onSelect={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FlySelectItem({
  option,
  selected,
  striped,
  onSelect,
}: {
  option: FlySelectOption;
  selected: boolean;
  striped: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const style: React.CSSProperties = {
    padding: '10px 16px',
    fontSize: '1.4rem',
    color: selected ? C.green : C.white,
    background: hover ? C.grayDark50 : striped ? C.grayDarkAlt : 'transparent',
    cursor: 'pointer',
    transition: 'background 0.1s',
  };
  return (
    <div
      style={style}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {option.label}
    </div>
  );
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

type SpinnerProps = {
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export function Spinner({ className, style, children }: SpinnerProps): React.ReactElement {
  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    color: C.gray25,
    fontSize: '1.4rem',
    fontWeight: 300,
    ...style,
  };
  // Inject keyframes once
  useEffect(() => {
    const id = 'cws-spinner-keyframes';
    if (document.getElementById(id)) return;
    const sheet = document.createElement('style');
    sheet.id = id;
    sheet.textContent = `@keyframes cwsSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`;
    document.head.appendChild(sheet);
  }, []);
  return (
    <span className={className} style={containerStyle}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        style={{ animation: 'cwsSpin 1s linear infinite' }}
      >
        <circle
          cx="9"
          cy="9"
          r="7"
          stroke={C.grayDark50}
          strokeWidth="2"
          fill="none"
        />
        <path
          d="M9 2a7 7 0 0 1 7 7"
          stroke={C.gray25}
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      {children}
    </span>
  );
}

// ─── Divider ─────────────────────────────────────────────────────────────────

type DividerProps = {
  marginSize?: 'xs' | 's' | 'm' | 'l' | 'xl';
  thin?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

const marginSizes = { xs: 5, s: 10, m: 20, l: 30, xl: 40 };

export function Divider({
  marginSize = 'm',
  thin,
  className,
  style,
  children,
}: DividerProps): React.ReactElement {
  const m = marginSizes[marginSize];
  const base: React.CSSProperties = {
    position: 'relative' as const,
    borderBottom: `${thin ? 1 : 2}px solid ${C.grayDark50}`,
    marginTop: m,
    marginBottom: m,
    ...style,
  };
  return (
    <div className={className} style={base}>
      {children && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: C.grayDark,
            padding: '0 8px',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
