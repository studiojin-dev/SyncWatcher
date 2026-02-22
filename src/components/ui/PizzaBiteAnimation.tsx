import { useId } from 'react';
import styles from './PizzaBiteAnimation.module.css';

interface BiteCircle {
  cx: number;
  cy: number;
  r: number;
}

interface PizzaBiteAnimationProps {
  className?: string;
}

const frameBites: BiteCircle[][] = [
  [],
  [
    { cx: 88, cy: 77, r: 8 },
  ],
  [
    { cx: 88, cy: 77, r: 8 },
    { cx: 85, cy: 63, r: 9 },
  ],
  [
    { cx: 88, cy: 77, r: 8 },
    { cx: 85, cy: 63, r: 9 },
    { cx: 79, cy: 48, r: 10 },
  ],
];

export default function PizzaBiteAnimation({ className }: PizzaBiteAnimationProps) {
  const rawId = useId();
  const idPrefix = rawId.split(':').join('');

  return (
    <div
      className={`${styles.pizzaBiteAnimation} ${className ?? ''}`.trim()}
      data-testid="pizza-bite-animation"
      aria-hidden="true"
    >
      {frameBites.map((bites, index) => {
        const maskId = `${idPrefix}-pizza-mask-${index}`;
        const frameClass = `${styles.pizzaBiteFrame} ${styles[`pizzaBiteFrame${index + 1}`]}`;

        return (
          <svg
            key={maskId}
            viewBox="0 0 100 100"
            className={frameClass}
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <mask id={maskId}>
                <rect width="100" height="100" fill="white" />
                {bites.map((bite, biteIndex) => (
                  <circle
                    key={`${maskId}-bite-${biteIndex}`}
                    cx={bite.cx}
                    cy={bite.cy}
                    r={bite.r}
                    fill="black"
                  />
                ))}
              </mask>
            </defs>

            <g mask={`url(#${maskId})`}>
              <path d="M50 8 L6 92 H94 Z" fill="#FFD43B" stroke="#000000" strokeWidth="4" />
              <path d="M8 88 Q50 96 92 88 L94 92 H6 Z" fill="#D28A2D" stroke="#000000" strokeWidth="2.5" />
              <circle cx="38" cy="61" r="8" fill="#FF6B6B" stroke="#000000" strokeWidth="2.5" />
              <circle cx="58" cy="72" r="7" fill="#FF6B6B" stroke="#000000" strokeWidth="2.5" />
              <circle cx="50" cy="50" r="6.5" fill="#FF6B6B" stroke="#000000" strokeWidth="2.5" />
              <path d="M29 40 Q38 44 47 40" stroke="#000000" strokeWidth="2" strokeLinecap="round" fill="none" />
              <path d="M43 29 Q52 33 61 29" stroke="#000000" strokeWidth="2" strokeLinecap="round" fill="none" />
            </g>
          </svg>
        );
      })}
    </div>
  );
}
