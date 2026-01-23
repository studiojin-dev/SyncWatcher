import { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface PageTransitionProps {
    children: ReactNode;
    pageKey: string;
}

/**
 * Page transition wrapper with Framer Motion
 * Subtle fade-in with slight vertical movement (as per DESIGN_SYSTEM.md)
 */
export function PageTransition({ children, pageKey }: PageTransitionProps) {
    return (
        <AnimatePresence mode="wait">
            <motion.div
                key={pageKey}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{
                    duration: 0.15,
                    ease: [0.33, 1, 0.68, 1], // ease-out
                }}
            >
                {children}
            </motion.div>
        </AnimatePresence>
    );
}

interface CardAnimationProps {
    children: ReactNode;
    index?: number;
}

/**
 * Card animation wrapper with staggered entrance
 */
export function CardAnimation({ children, index = 0 }: CardAnimationProps) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.2,
                delay: index * 0.05, // Stagger effect
                ease: [0.33, 1, 0.68, 1],
            }}
        >
            {children}
        </motion.div>
    );
}

interface FadeInProps {
    children: ReactNode;
    delay?: number;
}

/**
 * Simple fade-in animation
 */
export function FadeIn({ children, delay = 0 }: FadeInProps) {
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
                duration: 0.2,
                delay,
                ease: [0.65, 0, 0.35, 1], // ease-in-out
            }}
        >
            {children}
        </motion.div>
    );
}

export default { PageTransition, CardAnimation, FadeIn };
