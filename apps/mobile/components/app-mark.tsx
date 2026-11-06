import { Image, StyleSheet, View } from "react-native";
import appMark from "../assets/app-mark.png";
import { useThemedStyles } from "../lib/native";

const MARK = 56;

export function AppMark() {
  const styles = useThemedStyles(createAppMarkStyles);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.circle}
    >
      <Image source={appMark} style={styles.image} />
    </View>
  );
}

function createAppMarkStyles() {
  return StyleSheet.create({
    circle: {
      width: MARK,
      height: MARK,
      borderRadius: MARK / 2,
      overflow: "hidden",
      alignSelf: "center",
    },
    image: {
      width: MARK,
      height: MARK,
    },
  });
}
