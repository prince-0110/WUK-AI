import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Dimensions, View } from 'react-native';
import { colors } from '../theme';

const GLYPHS = '01WUK72アイウエオカキクケコ';

export default function MatrixRain({ enabled }) {
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [reducedMotion, setReducedMotion] = useState(false);
  const { width, height } = Dimensions.get('window');
  const columns = Math.min(14, Math.max(8, Math.ceil(width / 34)));
  const [values] = useState(() => Array.from({ length: columns }, () => new Animated.Value(-height)));

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
      const duration = 6500 + (index % 5) * 950;
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(value, { toValue: height + 100, duration, useNativeDriver: true }),
        Animated.timing(value, { toValue: -height - 100, duration: 0, useNativeDriver: true }),
      ]));
      loop.start();
      return loop;
    });
    return () => animations.forEach(animation => animation.stop());
  }, [enabled, active, reducedMotion, height, values]);

  if (!enabled || reducedMotion) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', opacity: 0.12 }}>
    {values.map((value, index) => <Animated.Text key={index} numberOfLines={8} style={{ position: 'absolute', left: 8 + index * (width / columns), top: 0, transform: [{ translateY: value }], color: colors.deepBlue, fontSize: 10, lineHeight: 17, fontFamily: 'monospace' }}>
      {Array.from({ length: 8 }, (_, row) => GLYPHS[(index * 7 + row * 3) % GLYPHS.length]).join('\n')}
    </Animated.Text>)}
  </View>;
}
