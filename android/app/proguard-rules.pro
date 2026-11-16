# kotlinx.serialization: keep generated serializers and the custom rule serializer.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class app.homecast.**$$serializer { *; }
-keepclassmembers class app.homecast.** { *** Companion; }
-keepclasseswithmembers class app.homecast.** { kotlinx.serialization.KSerializer serializer(...); }
-keep class app.homecast.contract.** { *; }
# Service/entities referenced from the manifest or by reflection-like frameworks.
-keep class app.homecast.playback.PlaybackService { *; }
-keep class app.homecast.playback.DownloadWorker { *; }
-dontwarn org.slf4j.**
-dontwarn javax.annotation.**
