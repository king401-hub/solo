# Vosk talks to its native library through JNA; R8 must not strip or rename these.
-keep class com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }
-keep class org.vosk.** { *; }
# JNA references desktop AWT classes that do not exist on Android and are never used there.
-dontwarn java.awt.**
