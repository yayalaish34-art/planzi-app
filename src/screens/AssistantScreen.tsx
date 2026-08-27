import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  StyleSheet,
  Animated,
  Easing,
  Image,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { X, Mic, Undo2, RotateCcw, Send, Sparkles } from 'lucide-react-native';
import Svg, {
  G,
  Path,
  Circle,
  Defs,
  LinearGradient as SvgGradient,
  Stop,
} from 'react-native-svg';

import { Screen } from '../components/ui';
import { api } from '../lib/api';
import { useVoiceSession } from '../lib/useVoiceSession';
import type { RootStackParamList } from '../navigation';
import { spacing, font, VOICE } from '../theme';
import { t, locale, isRTL } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Assistant'>;

const MINUTE = 60_000;

// ── The band of sound behind the mic ──────────────────────────────────────
// A stack of sine curves whose amplitude runs from -max to +max, so the set
// reads as one ribbon rather than a graph. A two-lobe envelope opens it at 24%
// and 76% of the width and closes it to nothing in the middle, which is where
// the button sits: the waves come out from behind her, not through her.
//
// It is a meter, not decoration. The height follows the microphone while she
// listens, so the band answers "is it hearing me" without a word; when nobody
// is talking it lies down flat, which is the only honest thing a level meter
// can do at silence.
const WAVE_HEIGHT = 176;
/** Curves either side of the centre line. 13 → 27 paths, redrawn 30× a second. */
const WAVE_LINES = 13;
const WAVE_AMP = 30;
/** Sampling step in px. Finer than this buys nothing at phone widths. */
const WAVE_STEP = 8;
/** Frame budget. 30fps is smooth for something this soft, and half the work. */
const WAVE_FRAME_MS = 33;
/** How fast the curves travel. Each one drifts a little faster than the last,
    which is what keeps the mesh churning instead of sliding as one sheet. */
const WAVE_SPEED = 2.4;
/** Below this the ribbon has closed onto the flat line; stop drawing it. */
const WAVE_SILENT = 0.004;

type WaveFrame = { paths: { d: string; opacity: number }[]; opacity: number };
const WAVE_NONE: WaveFrame = { paths: [], opacity: 0 };

function waveEnvelope(t: number): number {
  const left = Math.exp(-Math.pow((t - 0.24) / 0.135, 2));
  const right = Math.exp(-Math.pow((t - 0.76) / 0.135, 2));
  // Fades the whole band out at both screen edges.
  return (left + right) * Math.pow(Math.sin(Math.PI * t), 0.55);
}

/**
 * The x positions and their envelope value, solved once per screen width.
 *
 * The envelope never changes — only the amplitude and the phase do — so
 * keeping it out of the frame loop is most of what makes the loop cheap.
 */
type WaveGrid = { width: number; xs: number[]; env: number[] };

function waveGrid(width: number): WaveGrid {
  const xs: number[] = [];
  for (let x = 0; x < width; x += WAVE_STEP) xs.push(x);
  xs.push(width);
  return { width, xs, env: xs.map((x) => waveEnvelope(x / width)) };
}

/** One frame of the ribbon. `amp` is 0–1: the smoothed level of the voice. */
function wavePaths(grid: WaveGrid, amp: number, phase: number): WaveFrame {
  const cy = WAVE_HEIGHT / 2;
  const { width, xs, env } = grid;
  const paths: { d: string; opacity: number }[] = [];

  for (let i = -WAVE_LINES; i <= WAVE_LINES; i++) {
    const k = i / WAVE_LINES;
    const a = WAVE_AMP * k * amp;
    const w = (2 * Math.PI * (3.1 + Math.abs(k) * 0.9)) / width;
    const drift = i * 0.34 + phase * (1 + Math.abs(k) * 0.25);

    let d = '';
    for (let j = 0; j < xs.length; j++) {
      const x = xs[j];
      const y = cy + a * env[j] * Math.sin(w * x + drift);
      d += `${j === 0 ? 'M' : 'L'}${x} ${Math.round(y * 10) / 10}`;
    }

    // The outermost curves are the faintest, so the ribbon has a lit core.
    paths.push({ d, opacity: 0.1 + 0.26 * (1 - Math.abs(k)) });
  }

  // Fading it out as it closes is what hides the seam: 27 curves collapsed
  // onto one line would otherwise stack into a bar far darker than the line
  // they are supposed to become.
  return { paths, opacity: Math.min(1, amp * 4) };
}

/**
 * "09:30–10:30". The range rather than a single time, so a tile answers "does
 * it fit" without a duration label beside it.
 *
 * Wrapped in isolates: a clock range is left-to-right whatever the paragraph
 * around it is doing, and without them the two halves swap in Hebrew.
 */
function clockRange(iso: string, durationMinutes: number): string {
  const fmt = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' });
  const start = new Date(iso);
  const end = new Date(start.getTime() + durationMinutes * MINUTE);
  return `⁦${fmt.format(start)}–${fmt.format(end)}⁩`;
}

/**
 * Which day it lands on, in the reader's own language.
 *
 * Today needs no label — the time alone is unambiguous — but the column would
 * go ragged without one, so it takes the weekday like the rest. Everything is
 * formatted by Intl rather than translated by hand: seven languages of
 * "tomorrow evening" is seven chances to get it wrong.
 */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.round(
    (new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000,
  );
  return days < 7
    ? d.toLocaleDateString(locale(), { weekday: 'long' })
    : d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Anything she says, with her mark beside it.
 *
 * The avatar is what tells the two voices apart at a glance — the bubbles
 * differ by fill, which is thin on its own and gone entirely in a screenshot
 * read at arm's length.
 */
function BotRow({ rtl, children }: { rtl: boolean; children: ReactNode }) {
  return (
    <View style={[styles.botRow, rtl && styles.botRowRtl]}>
      <View style={styles.avatar}>
        <Sparkles color={VOICE.violetSoft} fill={VOICE.violetSoft} size={17} />
      </View>
      {children}
    </View>
  );
}

/**
 * The assistant, out loud.
 *
 * She opens the conversation, listens, does what she is asked, and answers —
 * there is nothing to type here, by design. The one control is the orb: tap it
 * to say you are finished talking, or to cut in while she is speaking.
 */
export default function AssistantScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState<string>('');
  const scrollRef = useRef<ScrollView>(null);
  const { width } = useWindowDimensions();
  // Bubble sides are physical, not mirrored: what you said stays on the right
  // in Hebrew too, the way every messaging app on the phone does it.
  const rtl = isRTL();

  useEffect(() => {
    let active = true;
    void api.getMe().then(({ user }) => {
      if (active) setName(user.name ?? '');
    });
    return () => {
      active = false;
    };
  }, []);

  const {
    state, lines, level, error, undoable,
    toggle, send, chooseTime, undoLast, startOver, restart, end,
  } = useVoiceSession({ userName: name || undefined });
  const [draft, setDraft] = useState('');

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    send(text);
  };

  // ── The band, driven by the voice ──────────────────────────────────────
  // The grid is pure geometry, so it is only solved when the screen changes
  // width — a rotation, or a split view. Everything else is per frame.
  const grid = useMemo(() => waveGrid(width), [width]);
  const [wave, setWave] = useState<WaveFrame>(WAVE_NONE);

  // Read inside the frame loop, which must not restart when they change.
  const levelRef = useRef(level);
  levelRef.current = level;
  const stateRef = useRef(state);
  stateRef.current = state;

  // Carried across restarts of the loop, so falling silent is a ramp rather
  // than a cut.
  const ampRef = useRef(0);
  const phaseRef = useRef(0);

  const animating = state === 'listening' || state === 'speaking';

  useEffect(() => {
    let raf = 0;
    let lastDrawn = 0;
    let lastFrame = 0;
    let closed = false;

    const tick = (now: number) => {
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0;
      lastFrame = now;

      const live = stateRef.current;
      // While she talks there is no microphone to follow, so the band gets a
      // swell of its own rather than standing at one height.
      const target =
        live === 'listening'
          ? levelRef.current
          : live === 'speaking'
            ? 0.45 + 0.22 * Math.sin(now / 260)
            : 0;

      // Fast up, slow down — a level meter that fell as fast as it rose would
      // flicker on every gap between words.
      const amp = ampRef.current;
      ampRef.current = amp + (target - amp) * (target > amp ? 0.35 : 0.1);
      phaseRef.current += dt * WAVE_SPEED;

      const quiet = ampRef.current < WAVE_SILENT;

      if (quiet) {
        ampRef.current = 0;
        if (!closed) {
          closed = true;
          setWave(WAVE_NONE);
        }
        // Closed *and* nobody is talking: nothing will reopen it until the
        // state changes, and that restarts this effect. A pause between words
        // is not that — the loop has to stay up to catch the next one.
        if (!animating) return;
      } else {
        closed = false;
      }

      raf = requestAnimationFrame(tick);
      if (quiet || now - lastDrawn < WAVE_FRAME_MS) return;
      lastDrawn = now;
      setWave(wavePaths(grid, ampRef.current, phaseRef.current));
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [grid, animating]);

  // ── The orb: a slow breath, plus the mic level while she listens ──
  const breath = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

  useEffect(() => {
    Animated.timing(pulse, {
      toValue: state === 'listening' ? level : state === 'speaking' ? 0.55 : 0,
      duration: 120,
      useNativeDriver: true,
    }).start();
  }, [level, state, pulse]);

  useEffect(() => {
    // Keep the newest line in view as the conversation grows.
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [lines.length]);

  const close = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    end();
    navigation.goBack();
  };

  const caption =
    state === 'listening'
      ? t('voice.listening')
      : state === 'thinking'
        ? t('voice.thinking')
        : state === 'speaking'
          ? t('voice.speaking')
          : state === 'unavailable'
            ? error === 'microphone'
              ? t('voice.micDenied')
              : t('voice.unavailable')
            : state === 'stopped'
              ? t('voice.ended')
              : t('voice.starting');

  const hint =
    state === 'listening'
      ? t('voice.tapToStop')
      : state === 'speaking'
        ? t('voice.tapToInterrupt')
        : state === 'starting' || state === 'thinking'
          ? t('voice.hint')
          : '';

  const orbScale = Animated.add(
    breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }),
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
  );

  const deleted = undoable.filter((c) => c.destructive);

  return (
    // The lavender ground sits behind the screen rather than inside it, so it
    // runs under the safe-area padding to all four edges.
    <LinearGradient colors={VOICE.bg} style={styles.ground}>
      <Screen clearTabBar={false} style={styles.screen}>
        <View style={styles.headerRow}>
          <Pressable onPress={close} style={styles.iconBtn} accessibilityRole="button">
            <X color={VOICE.ink} size={19} strokeWidth={2.1} />
          </Pressable>
          <Text style={styles.title}>{t('voice.title')}</Text>
          {/* The thread carries across visits, so there has to be a way to drop
              it and begin again. */}
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              startOver();
              navigation.replace('Assistant');
            }}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={t('voice.newChat')}
          >
            <RotateCcw color={VOICE.violet} size={19} strokeWidth={2.1} />
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
          showsVerticalScrollIndicator={false}
        >
          {lines.map((line) => {
            // A picture is its own bubble: the frame is the message, so the
            // padding and the background that carry text would only box it in.
            if (line.imageUri) {
              return (
                <BotRow key={line.id} rtl={rtl}>
                  <View style={styles.imageBubble}>
                    <Image
                      source={{ uri: line.imageUri }}
                      style={styles.image}
                      resizeMode="cover"
                      accessibilityRole="image"
                      accessibilityLabel={t('voice.drawing')}
                    />
                  </View>
                </BotRow>
              );
            }

            if (line.drawing) {
              return (
                <BotRow key={line.id} rtl={rtl}>
                  <View style={[styles.herBubble, styles.drawingBubble]}>
                    <ActivityIndicator size="small" color={VOICE.violetSoft} />
                    <Text style={styles.herText}>{t('voice.drawing')}</Text>
                  </View>
                </BotRow>
              );
            }

            const offer = line.offer;
            const showOffer = offer && offer.options.length > 0;

            const bubble = (
              <View
                style={[
                  line.role === 'user' ? styles.userBubble : styles.herBubble,
                  showOffer && styles.offerBubble,
                ]}
              >
                {line.text ? (
                  <Text style={line.role === 'user' ? styles.userText : styles.herText}>
                    {line.text}
                  </Text>
                ) : null}

                {/* The times sit inside her own bubble rather than in a card of
                    their own: this is the end of what she said, not a form the
                    app put in the way. */}
                {showOffer ? (
                  <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
                    {offer.options.map((iso) => {
                      const taken = line.chosen === iso;
                      const spent = Boolean(line.chosen) && !taken;
                      return (
                        <Pressable
                          key={iso}
                          onPress={() => chooseTime(line.id, iso)}
                          disabled={Boolean(line.chosen)}
                          style={({ pressed }) => [
                            styles.offerRow,
                            taken && styles.offerRowTaken,
                            spent && styles.offerRowSpent,
                            pressed && styles.offerRowPressed,
                          ]}
                          accessibilityRole="button"
                          accessibilityState={{ selected: taken, disabled: Boolean(line.chosen) }}
                          accessibilityLabel={`${offer.title} — ${clockRange(iso, offer.durationMinutes)}, ${whenLabel(iso)}`}
                        >
                          <Text
                            style={[styles.offerTime, taken && styles.offerTimeTaken]}
                            numberOfLines={1}
                          >
                            {clockRange(iso, offer.durationMinutes)}
                          </Text>
                          <Text
                            style={[styles.offerWhen, taken && styles.offerWhenTaken]}
                            numberOfLines={1}
                          >
                            {whenLabel(iso)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );

            return line.role === 'user' ? (
              <View key={line.id} style={[styles.userRow, rtl && styles.userRowRtl]}>
                {bubble}
              </View>
            ) : (
              <BotRow key={line.id} rtl={rtl}>{bubble}</BotRow>
            );
          })}
        </ScrollView>

        {deleted.length > 0 ? (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              undoLast();
            }}
            style={styles.undoBar}
            accessibilityRole="button"
          >
            <Undo2 color={VOICE.violet} size={16} />
            <Text style={styles.undoText} numberOfLines={1}>
              {t('voice.undo')} · {deleted.map((c) => c.title).join(', ')}
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.stage}>
          <View style={styles.micArea}>
            {/* Decorative, and wider than the column it sits in — it runs to
                both screen edges the way the sound does. */}
            <View style={styles.waveWrap} pointerEvents="none">
              <Svg width={width} height={WAVE_HEIGHT}>
                <Defs>
                  <SvgGradient id="waveInk" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#9DC0EE" />
                    <Stop offset="0.24" stopColor="#A78BE8" />
                    <Stop offset="0.5" stopColor="#C6BAF3" />
                    <Stop offset="0.76" stopColor="#A78BE8" />
                    <Stop offset="1" stopColor="#9DC0EE" />
                  </SvgGradient>
                  <SvgGradient id="waveRest" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#9DC0EE" stopOpacity="0" />
                    <Stop offset="0.5" stopColor="#B4A6EF" stopOpacity="0.5" />
                    <Stop offset="1" stopColor="#9DC0EE" stopOpacity="0" />
                  </SvgGradient>
                </Defs>

                {/* Silence. Always drawn, so the ribbon has a line to close
                    onto rather than a gap to disappear into. */}
                <Path
                  d={`M0 ${WAVE_HEIGHT / 2}L${width} ${WAVE_HEIGHT / 2}`}
                  fill="none"
                  stroke="url(#waveRest)"
                  strokeWidth={1.1}
                />

                <G opacity={wave.opacity}>
                  {wave.paths.map((w, i) => (
                    <Path
                      key={i}
                      d={w.d}
                      fill="none"
                      stroke="url(#waveInk)"
                      strokeWidth={0.6}
                      opacity={w.opacity}
                    />
                  ))}
                </G>
              </Svg>
            </View>

            {/* The ring the button sits inside, drawn rather than shadowed:
                a dashed stroke is the one part of the halo that survives at
                any brightness. */}
            <View style={styles.dottedRing} pointerEvents="none">
              <Svg width={140} height={140} viewBox="0 0 100 100">
                <Circle
                  cx="50"
                  cy="50"
                  r="48"
                  fill="none"
                  stroke="rgba(122, 100, 214, 0.38)"
                  strokeWidth={0.9}
                  strokeLinecap="round"
                  strokeDasharray="0.6 5"
                />
              </Svg>
            </View>

            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                toggle();
              }}
              disabled={state === 'unavailable'}
              accessibilityRole="button"
              accessibilityLabel={caption}
            >
              <Animated.View style={[styles.orbHalo, { transform: [{ scale: orbScale }] }]}>
                <View style={styles.orb}>
                  <View style={styles.orbInner}>
                    <Mic color={VOICE.violet} size={34} strokeWidth={2.1} />
                  </View>
                </View>
              </Animated.View>
            </Pressable>
          </View>

          <Text style={styles.caption}>{caption}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}

          {/* Talking is the point, but typing has to be there too — for a noisy
              room, a long title, or a name she keeps mishearing. Same thread. */}
          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t('assistant.placeholder')}
              placeholderTextColor={VOICE.muted}
              style={styles.composerInput}
              returnKeyType="send"
              onSubmitEditing={submitDraft}
              editable={state !== 'unavailable' || error === 'microphone'}
            />
            <Pressable
              onPress={submitDraft}
              disabled={!draft.trim()}
              style={[styles.sendBtn, !draft.trim() && styles.sendBtnIdle]}
              accessibilityRole="button"
              accessibilityLabel={t('assistant.send')}
            >
              <LinearGradient
                colors={VOICE.send}
                start={{ x: 0.15, y: 0 }}
                end={{ x: 0.85, y: 1 }}
                style={styles.sendFill}
              >
                {/* The paper plane flies the way the language reads. */}
                <Send color="#FFFFFF" size={18} style={isRTL() ? styles.mirrored : undefined} />
              </LinearGradient>
            </Pressable>
          </View>

          {state === 'stopped' ? (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                // Restarts the loop in place. This used to remount the
                // screen, which threw away the thread on screen and was the
                // same motion the user was already making by hand.
                restart();
              }}
              style={styles.restartBtn}
            >
              <Text style={styles.restartText}>{t('voice.restart')}</Text>
            </Pressable>
          ) : null}
        </View>
      </Screen>
    </LinearGradient>
  );
}

/**
 * Everything white on this screen floats rather than sits: one soft violet
 * shadow, reused, is what separates the bubbles from the lavender.
 */
const lift = {
  shadowColor: VOICE.shadow,
  shadowOpacity: 0.09,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 6 },
  elevation: 3,
} as const;

const styles = StyleSheet.create({
  ground: { flex: 1 },
  screen: { backgroundColor: 'transparent' },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: VOICE.surface,
    ...lift,
  },
  title: { fontSize: 21, ...font(700), color: VOICE.ink, letterSpacing: -0.2 },

  transcript: { flex: 1 },
  transcriptContent: { paddingVertical: spacing.md, gap: 14 },

  // Her mark and her bubble travel together, so the row stretches and the
  // bubble inside it carries the width limit.
  //
  // Both rows pin to a physical side rather than a logical one. Under a
  // mirrored layout `row` already runs right-to-left, so `row-reverse` is what
  // puts her back on the left with her mark on the outside of it.
  botRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    alignSelf: 'stretch',
  },
  botRowRtl: { flexDirection: 'row-reverse' },
  userRow: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'flex-end' },
  userRowRtl: { justifyContent: 'flex-start' },
  avatar: {
    width: 33,
    height: 33,
    borderRadius: 17,
    marginTop: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: VOICE.surface,
    ...lift,
  },

  // Fixed rather than max width, so every offer lines up under a short
  // sentence and the four rows share one edge.
  offerBubble: { width: '80%' },
  offerStack: { gap: 8, alignSelf: 'stretch' },
  offerStackSpaced: { marginTop: 10 },
  offerRow: {
    height: 52,
    borderRadius: 14,
    backgroundColor: VOICE.bubble,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 10,
  },
  offerRowPressed: { opacity: 0.72 },
  // Her own violet is this screen's "selected"; a faded tint reads as broken.
  offerRowTaken: { backgroundColor: VOICE.violet },
  offerRowSpent: { opacity: 0.4 },
  offerTime: {
    fontSize: 20,
    ...font(700),
    color: VOICE.ink,
    letterSpacing: -0.3,
    flexShrink: 0,
  },
  offerTimeTaken: { color: '#FFFFFF' },
  offerWhen: { flex: 1, fontSize: 14, ...font(600), color: VOICE.violetSoft, textAlign: 'right' },
  offerWhenTaken: { color: 'rgba(255,255,255,0.75)' },

  imageBubble: {
    maxWidth: '80%',
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: VOICE.bubble,
  },
  // Square, because that is the shape asked for unless the user says otherwise,
  // and a fixed aspect keeps the thread from jumping as pictures load.
  image: { width: 240, aspectRatio: 1 },
  drawingBubble: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  herBubble: {
    maxWidth: '80%',
    backgroundColor: VOICE.bubble,
    borderRadius: 22,
    paddingHorizontal: 17,
    paddingVertical: 13,
  },
  herText: { fontSize: 14.5, ...font(500), color: VOICE.inkSoft, lineHeight: 22.5 },
  userBubble: {
    maxWidth: '84%',
    backgroundColor: VOICE.surface,
    borderRadius: 22,
    paddingHorizontal: 17,
    paddingVertical: 13,
    ...lift,
  },
  userText: { fontSize: 14.5, ...font(500), color: VOICE.ink, lineHeight: 22.5 },

  undoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    backgroundColor: VOICE.surface,
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: spacing.sm,
    ...lift,
  },
  undoText: { fontSize: 14, ...font(600), color: VOICE.violet, flexShrink: 1 },

  stage: { alignItems: 'center', paddingBottom: spacing.lg },

  micArea: {
    alignSelf: 'stretch',
    height: WAVE_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dottedRing: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },

  // The white ring the button sits in — the mock's outermost halo, which RN
  // cannot draw as a second shadow.
  orbHalo: {
    width: 114,
    height: 114,
    borderRadius: 57,
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  orb: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: VOICE.surface,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: VOICE.violet,
    shadowOpacity: 0.32,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  orbInner: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 1,
    borderColor: 'rgba(126, 106, 216, 0.13)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  caption: { marginTop: spacing.md, fontSize: 15, ...font(600), color: VOICE.ink },
  hint: { marginTop: 2, fontSize: 13, ...font(400), color: VOICE.muted, textAlign: 'center' },

  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    height: 54,
    borderRadius: 27,
    paddingHorizontal: 6,
    backgroundColor: VOICE.surface,
    marginTop: spacing.md,
    ...lift,
  },
  composerInput: {
    flex: 1,
    backgroundColor: 'transparent',
    paddingHorizontal: 12,
    fontSize: 14.5,
    ...font(400),
    color: VOICE.ink,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    overflow: 'hidden',
  },
  sendFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sendBtnIdle: { opacity: 0.35 },
  mirrored: { transform: [{ scaleX: -1 }] },

  restartBtn: {
    marginTop: spacing.sm,
    backgroundColor: VOICE.surface,
    borderRadius: 100,
    paddingHorizontal: 22,
    paddingVertical: 12,
    ...lift,
  },
  restartText: { fontSize: 15, ...font(600), color: VOICE.violet },
});
