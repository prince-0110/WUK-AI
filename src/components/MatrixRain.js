import React, { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, useWindowDimensions, View } from 'react-native';

const GLYPHS = '01WUK72アイウエオカキクケコ';
const RAIN_GREEN = '#27856B';

export default function MatrixRain({ enabled }) {
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [reducedMotion, setReducedMotion] = useState(false);
  const { width, height } = useWindowDimensions();
  const columns = Math.min(14, Math.max(8, Math.ceil(width / 34)));
  const values = useMemo(() => Array.from({ length: columns }, (_, index) => {
    const startOffset = (index * 0.61803398875) % 1;
    return new Animated.Value(startOffset * height - height * 0.2);
  }), [columns, height]);

  useEffect(() => {
    const appState = AppState.addEventListener('change', state => setActive(state === 'active'));
    AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion).catch(() => {});
    const motion = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReducedMotion);
    return () => { appState.remove(); motion?.remove?.(); };
  }, []);

  useEffect(() => {
    if (!enabled || !active || reducedMotion) {
      values.forEach(value => value.stopAnimation());
      return undefined;
    }
    const animations = values.map((value, index) => {
      const duration = 7500 + (index % 5) * 850;
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(value, { toValue: height + 150, duration, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(value, { toValue: -height * 0.2, duration: 1, useNativeDriver: true }),
      ]));
      loop.start();
      return loop;
    });
    return () => animations.forEach(animation => animation.stop());
  }, [enabled, active, reducedMotion, height, values]);

  if (!enabled || reducedMotion) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', zIndex: 0 }}>
    {values.map((value, index) => <Animated.Text key={index} numberOfLines={10} style={{ position: 'absolute', left: 8 + index * (width / columns), top: 0, transform: [{ translateY: value }], color: RAIN_GREEN, opacity: 0.42, fontSize: 11, lineHeight: 19, fontFamily: 'monospace', fontWeight: '700' }}>
      {Array.from({ length: 10 }, (_, row) => GLYPHS[(index * 7 + row * 3) % GLYPHS.length]).join('\n')}
    </Animated.Text>)}
  </View>;
}
