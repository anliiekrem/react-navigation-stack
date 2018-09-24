import React from 'react';

import clamp from '../../utils/clamp';
import {
  Animated,
  StyleSheet,
  PanResponder,
  Platform,
  View,
  I18nManager,
  Easing,
  Dimensions,
} from 'react-native';
import {
  SceneView,
  StackActions,
  NavigationActions,
  withOrientation,
  NavigationProvider,
} from 'react-navigation';
import { ScreenContainer } from 'react-native-screens';
import {
  PanGestureHandler,
  NativeViewGestureHandler,
} from 'react-native-gesture-handler';

import Card from './StackViewCard';
import Header from '../Header/Header';

import TransitionConfigs from './StackViewTransitionConfigs';
import { supportsImprovedSpringAnimation } from '../../utils/ReactNativeFeatures';

const emptyFunction = () => {};

const IPHONE_XS_HEIGHT = 812; // iPhone X and XS
const IPHONE_XR_HEIGHT = 896; // iPhone XR and XS Max
const { width: WINDOW_WIDTH, height: WINDOW_HEIGHT } = Dimensions.get('window');
const IS_IPHONE_X =
  Platform.OS === 'ios' &&
  !Platform.isPad &&
  !Platform.isTVOS &&
  (WINDOW_HEIGHT === IPHONE_XS_HEIGHT ||
    WINDOW_WIDTH === IPHONE_XS_HEIGHT ||
    WINDOW_HEIGHT === IPHONE_XR_HEIGHT ||
    WINDOW_WIDTH === IPHONE_XR_HEIGHT);

const EaseInOut = Easing.inOut(Easing.ease);

/**
 * Enumerate possible values for validation
 */
const HEADER_LAYOUT_PRESET_VALUES = ['center', 'left'];
const HEADER_TRANSITION_PRESET_VALUES = ['uikit', 'fade-in-place'];

/**
 * The max duration of the card animation in milliseconds after released gesture.
 * The actual duration should be always less then that because the rest distance
 * is always less then the full distance of the layout.
 */
const ANIMATION_DURATION = 500;

/**
 * The gesture distance threshold to trigger the back behavior. For instance,
 * `1/2` means that moving greater than 1/2 of the width of the screen will
 * trigger a back action
 */
const POSITION_THRESHOLD = 1 / 2;

/**
 * The threshold (in pixels) to start the gesture action.
 */
const RESPOND_THRESHOLD = 20;

/**
 * The distance of touch start from the edge of the screen where the gesture will be recognized
 */
const GESTURE_RESPONSE_DISTANCE_HORIZONTAL = 25;
const GESTURE_RESPONSE_DISTANCE_VERTICAL = 135;

const animatedSubscribeValue = animatedValue => {
  if (!animatedValue.__isNative) {
    return;
  }
  if (Object.keys(animatedValue._listeners).length === 0) {
    animatedValue.addListener(emptyFunction);
  }
};

const getDefaultHeaderHeight = isLandscape => {
  if (Platform.OS === 'ios') {
    if (isLandscape && !Platform.isPad) {
      return 32;
    } else if (IS_IPHONE_X) {
      return 88;
    } else {
      return 64;
    }
  } else {
    return 56;
  }
};

class StackViewLayout extends React.Component {
  /**
   * Used to identify the starting point of the position when the gesture starts, such that it can
   * be updated according to its relative position. This means that a card can effectively be
   * "caught"- If a gesture starts while a card is animating, the card does not jump into a
   * corresponding location for the touch.
   */
  _gestureStartValue = 0;

  // tracks if a touch is currently happening
  _isResponding = false;

  /**
   * immediateIndex is used to represent the expected index that we will be on after a
   * transition. To achieve a smooth animation when swiping back, the action to go back
   * doesn't actually fire until the transition completes. The immediateIndex is used during
   * the transition so that gestures can be handled correctly. This is a work-around for
   * cases when the user quickly swipes back several times.
   */
  _immediateIndex = null;

  constructor(props) {
    super(props);

    this.state = {
      // Used when card's header is null and mode is float to make transition
      // between screens with headers and those without headers smooth.
      // This is not a great heuristic here. We don't know synchronously
      // on mount what the header height is so we have just used the most
      // common cases here.
      floatingHeaderHeight: getDefaultHeaderHeight(props.isLandscape),
    };
  }

  _renderHeader(scene, headerMode) {
    const { options } = scene.descriptor;
    const { header } = options;

    if (__DEV__ && typeof header === 'string') {
      throw new Error(
        `Invalid header value: "${header}". The header option must be a valid React component or null, not a string.`
      );
    }

    if (header === null && headerMode === 'screen') {
      return null;
    }

    // check if it's a react element
    if (React.isValidElement(header)) {
      return header;
    }

    // Handle the case where the header option is a function, and provide the default
    const renderHeader = header || (props => <Header {...props} />);

    const {
      headerLeftInterpolator,
      headerTitleInterpolator,
      headerRightInterpolator,
      headerBackgroundInterpolator,
    } = this._getTransitionConfig();

    const { transitionProps, ...passProps } = this.props;

    return (
      <NavigationProvider value={scene.descriptor.navigation}>
        {renderHeader({
          ...passProps,
          ...transitionProps,
          scene,
          mode: headerMode,
          transitionPreset: this._getHeaderTransitionPreset(),
          layoutPreset: this._getHeaderLayoutPreset(),
          backTitleVisible: this._getheaderBackTitleVisible(),
          leftInterpolator: headerLeftInterpolator,
          titleInterpolator: headerTitleInterpolator,
          rightInterpolator: headerRightInterpolator,
          backgroundInterpolator: headerBackgroundInterpolator,
        })}
      </NavigationProvider>
    );
  }

  _animatedSubscribe(props) {
    // Hack to make this work with native driven animations. We add a single listener
    // so the JS value of the following animated values gets updated. We rely on
    // some Animated private APIs and not doing so would require using a bunch of
    // value listeners but we'd have to remove them to not leak and I'm not sure
    // when we'd do that with the current structure we have. `stopAnimation` callback
    // is also broken with native animated values that have no listeners so if we
    // want to remove this we have to fix this too.
    animatedSubscribeValue(props.transitionProps.layout.width);
    animatedSubscribeValue(props.transitionProps.layout.height);
    animatedSubscribeValue(props.transitionProps.position);
  }

  _reset(resetToIndex, duration) {
    if (Platform.OS === 'ios' && supportsImprovedSpringAnimation()) {
      Animated.spring(this.props.transitionProps.position, {
        toValue: resetToIndex,
        stiffness: 5000,
        damping: 600,
        mass: 3,
        useNativeDriver: this.props.transitionProps.position.__isNative,
      }).start();
    } else {
      Animated.timing(this.props.transitionProps.position, {
        toValue: resetToIndex,
        duration,
        easing: EaseInOut,
        useNativeDriver: this.props.transitionProps.position.__isNative,
      }).start();
    }
  }

  _goBack(backFromIndex, duration) {
    const { navigation, position, scenes } = this.props.transitionProps;
    const toValue = Math.max(backFromIndex - 1, 0);

    // set temporary index for gesture handler to respect until the action is
    // dispatched at the end of the transition.
    this._immediateIndex = toValue;

    const onCompleteAnimation = () => {
      this._immediateIndex = null;
      const backFromScene = scenes.find(s => s.index === toValue + 1);
      if (!this._isResponding && backFromScene) {
        navigation.dispatch(
          NavigationActions.back({
            key: backFromScene.route.key,
            immediate: true,
          })
        );
        navigation.dispatch(StackActions.completeTransition());
      }
    };

    if (Platform.OS === 'ios' && supportsImprovedSpringAnimation()) {
      Animated.spring(position, {
        toValue,
        stiffness: 5000,
        damping: 600,
        mass: 3,
        useNativeDriver: position.__isNative,
      }).start(onCompleteAnimation);
    } else {
      Animated.timing(position, {
        toValue,
        duration,
        easing: EaseInOut,
        useNativeDriver: position.__isNative,
      }).start(onCompleteAnimation);
    }
  }

  _onFloatingHeaderLayout = e => {
    this.setState({ floatingHeaderHeight: e.nativeEvent.layout.height });
  };

  render() {
    let floatingHeader = null;
    const headerMode = this._getHeaderMode();

    if (headerMode === 'float') {
      const { scene } = this.props.transitionProps;
      floatingHeader = (
        <View
          style={styles.floatingHeader}
          pointerEvents="box-none"
          onLayout={this._onFloatingHeaderLayout}
        >
          {this._renderHeader(scene, headerMode)}
        </View>
      );
    }
    const {
      transitionProps: { scene, scenes },
    } = this.props;
    const { options } = scene.descriptor;

    const gesturesEnabled =
      typeof options.gesturesEnabled === 'boolean'
        ? options.gesturesEnabled
        : Platform.OS === 'ios';

    const containerStyle = [
      styles.container,
      this._getTransitionConfig().containerStyle,
    ];

    // TODO: activate only when within some distance of the edge of the screen
    // within the GESTURE_RESPONSE_DISTANCE_HORIZONTAL / VERTICAL threshold
    // https://github.com/kmagiera/react-native-gesture-handler/issues/293
    return (
      <PanGestureHandler
        minOffsetX={this._isGestureInverted() ? -15 : 15}
        maxDeltaY={5}
        onGestureEvent={this._handlePanGestureEvent}
        onHandlerStateChange={this._handlePanGestureStateChange}
        enabled={gesturesEnabled}
      >
        <View style={containerStyle}>
          <ScreenContainer style={styles.scenes}>
            {scenes.map(s => this._renderCard(s))}
          </ScreenContainer>
          {floatingHeader}
        </View>
      </PanGestureHandler>
    );
  }

  // Without using Reanimated it's not possible to do all of the following
  // stuff with native driver.
  _handlePanGestureEvent = ({ nativeEvent }) => {
    const { mode } = this.props;
    const isVertical = mode === 'modal';

    if (isVertical) {
      this._handleVerticalPan(nativeEvent);
    } else {
      this._handleHorizontalPan(nativeEvent);
    }
  };

  _isGestureInverted = () => {
    const {
      transitionProps: { scene },
    } = this.props;
    const { options } = scene.descriptor;
    const { gestureDirection } = options;

    return typeof gestureDirection === 'string'
      ? gestureDirection === 'inverted'
      : I18nManager.isRTL;
  };

  _handleHorizontalPan = nativeEvent => {
    let {
      transitionProps: { navigation, position, layout },
    } = this.props;

    let { index } = navigation.state;

    let distance = layout.width.__getValue();
    let translation = nativeEvent.translationX;

    if (this._isGestureInverted()) {
      translation *= -1;
    }

    let currentValue = 1 - translation / distance;
    let value = clamp(index - 1, currentValue, index);
    position.setValue(value);
  };

  _handleVerticalPan = nativeEvent => {
    // todo
  };

  _handlePanGestureStateChange = ({ nativeEvent }) => {
    const { oldState, state } = nativeEvent;
    // console.log({ nativeEvent })
  };

  _getHeaderMode() {
    if (this.props.headerMode) {
      return this.props.headerMode;
    }
    if (Platform.OS === 'android' || this.props.mode === 'modal') {
      return 'screen';
    }
    return 'float';
  }

  _getHeaderLayoutPreset() {
    const { headerLayoutPreset } = this.props;
    if (headerLayoutPreset) {
      if (__DEV__) {
        if (
          this._getHeaderTransitionPreset() === 'uikit' &&
          headerLayoutPreset === 'left' &&
          Platform.OS === 'ios'
        ) {
          console.warn(
            `headerTransitionPreset with the value 'uikit' is incompatible with headerLayoutPreset 'left'`
          );
        }
      }
      if (HEADER_LAYOUT_PRESET_VALUES.includes(headerLayoutPreset)) {
        return headerLayoutPreset;
      }

      if (__DEV__) {
        console.error(
          `Invalid configuration applied for headerLayoutPreset - expected one of ${HEADER_LAYOUT_PRESET_VALUES.join(
            ', '
          )} but received ${JSON.stringify(headerLayoutPreset)}`
        );
      }
    }

    if (Platform.OS === 'android') {
      return 'left';
    } else {
      return 'center';
    }
  }

  _getHeaderTransitionPreset() {
    // On Android or with header mode screen, we always just use in-place,
    // we ignore the option entirely (at least until we have other presets)
    if (Platform.OS === 'android' || this._getHeaderMode() === 'screen') {
      return 'fade-in-place';
    }

    const { headerTransitionPreset } = this.props;
    if (headerTransitionPreset) {
      if (HEADER_TRANSITION_PRESET_VALUES.includes(headerTransitionPreset)) {
        return headerTransitionPreset;
      }

      if (__DEV__) {
        console.error(
          `Invalid configuration applied for headerTransitionPreset - expected one of ${HEADER_TRANSITION_PRESET_VALUES.join(
            ', '
          )} but received ${JSON.stringify(headerTransitionPreset)}`
        );
      }
    }

    return 'fade-in-place';
  }

  _getheaderBackTitleVisible() {
    const { headerBackTitleVisible } = this.props;

    return headerBackTitleVisible;
  }

  _renderInnerScene(scene) {
    const { navigation, getComponent } = scene.descriptor;
    const SceneComponent = getComponent();

    const { screenProps } = this.props;
    const headerMode = this._getHeaderMode();
    if (headerMode === 'screen') {
      return (
        <View style={styles.container}>
          <View style={styles.scenes}>
            <SceneView
              screenProps={screenProps}
              navigation={navigation}
              component={SceneComponent}
            />
          </View>
          {this._renderHeader(scene, headerMode)}
        </View>
      );
    }
    return (
      <SceneView
        screenProps={screenProps}
        navigation={navigation}
        component={SceneComponent}
      />
    );
  }

  _getTransitionConfig = () => {
    const isModal = this.props.mode === 'modal';

    return TransitionConfigs.getTransitionConfig(
      this.props.transitionConfig,
      this.props.transitionProps,
      this.props.lastTransitionProps,
      isModal
    );
  };

  _renderCard = scene => {
    const { screenInterpolator } = this._getTransitionConfig();

    const style =
      screenInterpolator &&
      screenInterpolator({ ...this.props.transitionProps, scene });

    // When using a floating header, we need to add some top
    // padding on the scene.
    const { options } = scene.descriptor;
    const hasHeader = options.header !== null;
    const headerMode = this._getHeaderMode();
    let paddingTop = 0;
    if (hasHeader && headerMode === 'float' && !options.headerTransparent) {
      paddingTop = this.state.floatingHeaderHeight;
    }

    return (
      <Card
        {...this.props.transitionProps}
        key={`card_${scene.key}`}
        transparent={this.props.transparentCard}
        style={[style, { paddingTop }, this.props.cardStyle]}
        scene={scene}
      >
        {this._renderInnerScene(scene)}
      </Card>
    );
  };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // Header is physically rendered after scenes so that Header won't be
    // covered by the shadows of the scenes.
    // That said, we'd have use `flexDirection: 'column-reverse'` to move
    // Header above the scenes.
    flexDirection: 'column-reverse',
    overflow: 'hidden',
  },
  scenes: {
    flex: 1,
  },
  floatingHeader: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
  },
});

export default withOrientation(StackViewLayout);
