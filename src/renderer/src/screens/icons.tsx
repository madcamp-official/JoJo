import type { ReactNode } from 'react'
import type { LlmProvider } from '@shared/types'

// 담당 B — UI 아이콘 세트 (이모지 대체용, 인라인 SVG)
// 액션 아이콘은 currentColor 라인 스타일(Feather 계열)로 통일해 텍스트 색을 따라간다.
// provider 로고는 각 브랜드를 상징하는 단색 마크(브랜드 색).

function Line({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function EyeIcon() {
  return (
    <Line>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Line>
  )
}

export function EyeOffIcon() {
  return (
    <Line>
      <path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2" />
      <path d="M1 1l22 22" />
    </Line>
  )
}

export function PencilIcon() {
  return (
    <Line>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Line>
  )
}

export function TrashIcon() {
  return (
    <Line>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </Line>
  )
}

export function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <Line size={size}>
      <path d="M20 6L9 17l-5-5" />
    </Line>
  )
}

export function LockIcon() {
  return (
    <Line>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Line>
  )
}

export function KeyboardIcon() {
  return (
    <Line>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
    </Line>
  )
}

export function WarnIcon() {
  return (
    <Line>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </Line>
  )
}

// ---- provider 로고(브랜드 마크) --------------------------------------------

function GeminiLogo() {
  // 4-포인트 스파크(Gemini 마크)
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path
        d="M12 1.5c.7 5.2 3.3 7.8 8.5 8.5-5.2.7-7.8 3.3-8.5 8.5-.7-5.2-3.3-7.8-8.5-8.5 5.2-.7 7.8-3.3 8.5-8.5Z"
        fill="#4285F4"
      />
    </svg>
  )
}

function ClaudeLogo() {
  // 방사형 선버스트(Claude 마크) — 브랜드 러스트 색
  const rays = [0, 30, 60, 90, 120, 150]
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      {rays.map((a) => (
        <rect key={a} x="11" y="3" width="2" height="18" rx="1" transform={`rotate(${a} 12 12)`} fill="#D97757" />
      ))}
    </svg>
  )
}

function OpenAiLogo() {
  // 6-잎 블라썸 근사(OpenAI) — 브랜드 그린
  const petals = [0, 60, 120, 180, 240, 300]
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      {petals.map((a) => (
        <ellipse
          key={a}
          cx="12"
          cy="7"
          rx="2.8"
          ry="5"
          transform={`rotate(${a} 12 12)`}
          fill="#10A37F"
          fillOpacity="0.85"
        />
      ))}
    </svg>
  )
}

export function ProviderLogo({ provider }: { provider: LlmProvider }) {
  if (provider === 'gemini') return <GeminiLogo />
  if (provider === 'claude') return <ClaudeLogo />
  return <OpenAiLogo />
}
