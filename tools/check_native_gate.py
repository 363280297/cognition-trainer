"""Execute native gate/reminder policy with a JDK, without an APK or device.

Prefs, GateService and ReminderReceiver are compiled unchanged. Only the two
Bridge entry methods are copied verbatim into a minimal MainActivity host, so
WebView/media initialization is unnecessary. Android storage/UI stubs contain
no policy. All generated sources/classes live in a temporary directory.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "android/src/com/local/cognitiontrainer"

STUBS = {
    "android/content/SharedPreferences.java": """
package android.content;
public class SharedPreferences {
 private final java.util.Map<String,Object> values = new java.util.HashMap<>();
 public boolean contains(String k) { return values.containsKey(k); }
 public boolean getBoolean(String k, boolean d) { return (Boolean)values.getOrDefault(k,d); }
 public int getInt(String k, int d) { return (Integer)values.getOrDefault(k,d); }
 public String getString(String k, String d) { return (String)values.getOrDefault(k,d); }
 public Editor edit() { return new Editor(); }
 public class Editor {
  private final java.util.Map<String,Object> pending = new java.util.HashMap<>();
  public Editor putBoolean(String k, boolean v) { pending.put(k,v); return this; }
  public Editor putInt(String k, int v) { pending.put(k,v); return this; }
  public Editor putString(String k, String v) { pending.put(k,v); return this; }
  public void apply() { values.putAll(pending); }
 }
}
""",
    "android/content/Context.java": """
package android.content;
public class Context {
 public static final int MODE_PRIVATE=0;
 public static final String WINDOW_SERVICE="window", ALARM_SERVICE="alarm", NOTIFICATION_SERVICE="notification";
 public static SharedPreferences storage = new SharedPreferences();
 public SharedPreferences getSharedPreferences(String n,int m) { return storage; }
 public String getPackageName() { return "com.local.cognitiontrainer"; }
 public Object getSystemService(String n) {
  if (n.equals(WINDOW_SERVICE)) return new android.view.WindowManager();
  if (n.equals(ALARM_SERVICE)) return new android.app.AlarmManager();
  return new android.app.NotificationManager();
 }
 public android.content.res.Resources getResources() { return new android.content.res.Resources(); }
 public void startActivity(Intent i) {}
}
""",
    "android/content/Intent.java": """
package android.content;
public class Intent {
 public static final String ACTION_BOOT_COMPLETED="boot";
 public static final int FLAG_ACTIVITY_NEW_TASK=1, FLAG_ACTIVITY_SINGLE_TOP=2, FLAG_ACTIVITY_REORDER_TO_FRONT=4;
 private String action;
 public Intent() {} public Intent(Context c,Class<?> t) {}
 public Intent addFlags(int f) { return this; } public Intent putExtra(String k,boolean v) { return this; }
 public Intent setAction(String a) { action=a; return this; } public String getAction() { return action; }
}
""",
    "android/content/BroadcastReceiver.java": "package android.content; public abstract class BroadcastReceiver { public abstract void onReceive(Context c,Intent i); }",
    "android/content/res/Resources.java": "package android.content.res; public class Resources { public Metrics getDisplayMetrics(){return new Metrics();} public static class Metrics {public float density=1;} }",
    "android/webkit/JavascriptInterface.java": "package android.webkit; @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) public @interface JavascriptInterface {}",
    "android/accessibilityservice/AccessibilityService.java": """
package android.accessibilityservice;
public class AccessibilityService extends android.content.Context {
 public static final int GLOBAL_ACTION_HOME=2; public static int homes;
 public boolean performGlobalAction(int a){homes++; return true;}
 public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent e){}
 public void onInterrupt(){} public void onDestroy(){} protected void onServiceConnected(){}
 public boolean onUnbind(android.content.Intent i){return false;}
}
""",
    "android/view/accessibility/AccessibilityEvent.java": """
package android.view.accessibility;
public class AccessibilityEvent {
 public static final int TYPE_WINDOW_STATE_CHANGED=32;
 private final String pkg; private final int type;
 public AccessibilityEvent(String p){this(p,32);} public AccessibilityEvent(String p,int t){pkg=p;type=t;}
 public int getEventType(){return type;} public CharSequence getPackageName(){return pkg;}
}
""",
    "android/graphics/Color.java": "package android.graphics; public class Color {public static int parseColor(String s){return 0;}}",
    "android/graphics/PixelFormat.java": "package android.graphics; public class PixelFormat {public static final int OPAQUE=1;}",
    "android/view/Gravity.java": "package android.view; public class Gravity {public static final int CENTER=1;}",
    "android/view/KeyEvent.java": "package android.view; public class KeyEvent {public static final int KEYCODE_BACK=4;}",
    "android/view/View.java": """
package android.view;
public class View {
 public interface Click {void click(View v);} public interface Key {boolean key(View v,int code,KeyEvent e);}
 public void setOnClickListener(Click c){} public void setOnKeyListener(Key k){}
 public void setLayoutParams(Object p){} public void setFocusableInTouchMode(boolean b){} public void requestFocus(){}
}
""",
    "android/view/WindowManager.java": """
package android.view;
public class WindowManager {
 public static int adds,removes;
 public void addView(View v,LayoutParams p){adds++;} public void removeView(View v){removes++;}
 public static class LayoutParams {
  public static final int MATCH_PARENT=-1,TYPE_APPLICATION_OVERLAY=1,FLAG_LAYOUT_IN_SCREEN=2,FLAG_SHOW_WHEN_LOCKED=4;
  public LayoutParams(int a,int b,int c,int d,int e){}
 }
}
""",
    "android/widget/TextView.java": """
package android.widget;
public class TextView extends android.view.View {
 public static java.util.List<String> texts=new java.util.ArrayList<>();
 public TextView(android.content.Context c){} public void setText(String s){texts.add(s);}
 public void setTextColor(int c){} public void setTextSize(int s){}
}
""",
    "android/widget/Button.java": "package android.widget; public class Button extends TextView {public Button(android.content.Context c){super(c);}}",
    "android/widget/LinearLayout.java": """
package android.widget;
public class LinearLayout extends android.view.View {
 public static final int VERTICAL=1; public LinearLayout(android.content.Context c){}
 public void setOrientation(int i){} public void setBackgroundColor(int c){} public void setGravity(int g){}
 public void setPadding(int a,int b,int c,int d){} public void addView(android.view.View v){}
 public static class LayoutParams {public static final int MATCH_PARENT=-1,WRAP_CONTENT=-2; public int topMargin; public LayoutParams(int w,int h){} }
}
""",
    "android/os/Build.java": "package android.os; public class Build {public static class VERSION {public static final int SDK_INT=34;} public static class VERSION_CODES {public static final int O=26;}}",
    "android/app/AlarmManager.java": "package android.app; public class AlarmManager {public static final int RTC_WAKEUP=0; public static int scheduled; public void setAndAllowWhileIdle(int t,long when,PendingIntent p){scheduled++;} public void cancel(PendingIntent p){} }",
    "android/app/PendingIntent.java": """
package android.app;
public class PendingIntent {
 public static final int FLAG_UPDATE_CURRENT=1,FLAG_NO_CREATE=2,FLAG_IMMUTABLE=4;
 public static PendingIntent getBroadcast(android.content.Context c,int n,android.content.Intent i,int f){return new PendingIntent();}
 public static PendingIntent getActivity(android.content.Context c,int n,android.content.Intent i,int f){return new PendingIntent();}
}
""",
    "android/app/NotificationChannel.java": "package android.app; public class NotificationChannel {public NotificationChannel(String id,String name,int i){} public void setDescription(String s){} }",
    "android/app/NotificationManager.java": "package android.app; public class NotificationManager {public static final int IMPORTANCE_DEFAULT=1; public static int sent; public void createNotificationChannel(NotificationChannel c){} public void notify(int id,Notification n){sent++;}}",
    "android/app/Notification.java": """
package android.app;
public class Notification {
 public static class Builder {
  public Builder(android.content.Context c){} public Builder(android.content.Context c,String channel){}
  public Builder setSmallIcon(int i){return this;} public Builder setContentTitle(String s){return this;}
  public Builder setContentText(String s){return this;} public Builder setContentIntent(PendingIntent p){return this;}
  public Builder setAutoCancel(boolean b){return this;} public Builder setShowWhen(boolean b){return this;}
  public Notification build(){return new Notification();}
 }
}
""",
    "org/json/JSONArray.java": """
package org.json;
public class JSONArray {
 private final String[] values;
 public JSONArray(String s) {
  if (!s.startsWith("[") || !s.endsWith("]")) throw new IllegalArgumentException();
  String body=s.substring(1,s.length()-1).trim(); values=body.isEmpty()?new String[0]:body.split(",");
 }
 public int length(){return values.length;} public String getString(int i){return values[i].trim().replace("\\\"","");}
}
""",
    "com/local/cognitiontrainer/RootGate.java": "package com.local.cognitiontrainer; class RootGate {static void forceStop(String p){throw new AssertionError(\"root must not be called\");}}",
    "com/local/cognitiontrainer/GateWatch.java": "package com.local.cognitiontrainer; class GateWatch {static void start(android.content.Context c){throw new AssertionError(\"watch must not be called\");}}",
    "com/local/cognitiontrainer/R.java": "package com.local.cognitiontrainer; class R {static class mipmap {static final int ic_launcher=1;}}",
}

HARNESS = r'''
package com.local.cognitiontrainer;
import android.content.*;
import android.app.*;
import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import java.util.TimeZone;

public class NativeGateCheck {
 static int passed,failed;
 static final String PACKAGES="[\"example.game\"]";
 static void check(boolean b,String why){if(!b)throw new AssertionError(why);}
 static void test(String name,Runnable r){
  Context.storage=new SharedPreferences(); NotificationManager.sent=0; AlarmManager.scheduled=0;
  AccessibilityService.homes=0; android.widget.TextView.texts.clear();
  android.view.WindowManager.adds=0; android.view.WindowManager.removes=0;
  TimeZone old=TimeZone.getDefault();
  try{r.run();passed++;System.out.println("PASS "+name);}
  catch(Throwable e){failed++;System.out.println("FAIL "+name+": "+e);}
  finally{TimeZone.setDefault(old);}
 }
 static void sync(MainActivity c,int enabled,int met,String date,String summary,int skip){
  try{
   java.lang.reflect.Method m=MainActivity.Bridge.class.getMethod("setTrainingState",int.class,int.class,String.class,String.class,String.class,int.class);
   check(m.isAnnotationPresent(android.webkit.JavascriptInterface.class),"bridge must be exposed");
   m.invoke(c.new Bridge(),enabled,met,date,PACKAGES,summary,skip);
  }catch(ReflectiveOperationException e){throw new AssertionError("setTrainingState interface missing/failed",e);}
 }
 static void event(GateService service,String pkg){service.onAccessibilityEvent(new AccessibilityEvent(pkg));}
 public static void main(String[] args){
  test("legacy disabled gate does not suppress reminder",()->{
   MainActivity c=new MainActivity(); c.new Bridge().setGate(0,PACKAGES,"pending",1);
   new ReminderReceiver().onReceive(c,new Intent());
   check(!Prefs.dailyMet(c),"not armed is not completed");
   check(NotificationManager.sent==1,"reminder must fire");
  });
  test("legacy inferred completion is not trusted after upgrade",()->{
   MainActivity c=new MainActivity(); Context.storage.edit().putBoolean("armed",false)
    .putBoolean("dailyMet",true).putString("dailyDate",Prefs.today(c)).apply();
   check(!Prefs.dailyMet(c),"old derived completion is ambiguous");
   check(!Prefs.isArmed(c),"ambiguous legacy false must not enable gate");
  });
  test("undated legacy skip and summary do not lock today's overlay",()->{
   MainActivity c=new MainActivity(); Context.storage.edit().putBoolean("armed",true)
    .putBoolean("gateCanSkip",false).putString("gateSummary","yesterday done").apply();
   check(Prefs.isArmed(c),"preserve proven enabled setting");
   check(Prefs.gateCanSkip(c),"unknown skip status must allow dismissal");
   check(!Prefs.gateSummary(c).contains("yesterday"),"discard undated summary");
  });
  test("overlay states voluntary exit and backup limits truthfully",()->{
   MainActivity c=new MainActivity(); c.new Bridge().setGate(1,PACKAGES,"pending",1);
   event(new GateService(),"example.game");
   String text=String.join("\n",android.widget.TextView.texts);
   check(!text.contains("唯一的出口")&&!text.contains("只有一条路"),"uninstall is not the only exit");
   check(text.contains("备份"),"must explain external backups survive uninstall");
  });
  test("enabled and met matrix keeps reminders independent",()->{
   MainActivity c=new MainActivity();
   for(int enabled=0;enabled<=1;enabled++)for(int met=0;met<=1;met++){
    sync(c,enabled,met,Prefs.today(c),"today",1);
    check(Prefs.dailyMet(c)==(met==1),"actual met independent of enabled");
    check(Prefs.isArmed(c)==(enabled==1&&met==0),"gate matrix");
    NotificationManager.sent=0;new ReminderReceiver().onReceive(c,new Intent());
    check(NotificationManager.sent==(met==1?0:1),"reminder matrix");
   }
  });
  test("running native service restores next-day gate without WebView or alarm",()->{
   TimeZone.setDefault(TimeZone.getTimeZone("GMT-12:00"));
   MainActivity c=new MainActivity();String yesterday=Prefs.today(c);
   sync(c,1,1,yesterday,"finished yesterday",0);
   GateService service=new GateService();event(service,"example.game");
   check(AccessibilityService.homes==0,"complete today allows target");
   TimeZone.setDefault(TimeZone.getTimeZone("GMT+14:00"));
   check(!yesterday.equals(Prefs.today(c)),"test must cross local date");
   event(service,"example.game");
   check(AccessibilityService.homes==1,"native event must rearm on next day");
   check(!Prefs.dailyMet(c)&&Prefs.gateCanSkip(c),"stale met/skip expire");
   check(!Prefs.gateSummary(c).contains("yesterday"),"summary expires");
   new ReminderReceiver().onReceive(c,new Intent());
   check(NotificationManager.sent==1,"next day reminder fires");
   check(Prefs.isArmed(new Context()),"persisted state survives new context");
  });
  test("disabled gate remains disabled on rollover",()->{
   TimeZone.setDefault(TimeZone.getTimeZone("GMT-12:00"));MainActivity c=new MainActivity();
   sync(c,0,1,Prefs.today(c),"done",0);
   TimeZone.setDefault(TimeZone.getTimeZone("GMT+14:00"));event(new GateService(),"example.game");
   check(!Prefs.isArmed(c)&&AccessibilityService.homes==0,"preserve voluntary off");
  });
  test("existing overlay expires on next native event after date rollover",()->{
   TimeZone.setDefault(TimeZone.getTimeZone("GMT-12:00"));MainActivity c=new MainActivity();
   sync(c,1,0,Prefs.today(c),"yesterday locked",0);
   GateService s=new GateService();event(s,"example.game");
   check(android.view.WindowManager.adds==1,"overlay must exist before rollover");
   TimeZone.setDefault(TimeZone.getTimeZone("GMT+14:00"));event(s,c.getPackageName());
   check(android.view.WindowManager.removes==1,"stale overlay removed even on own-app event");
   check(Prefs.gateCanSkip(c),"yesterday's skip limit expires");
  });
  test("new completed or disabled state clears an existing overlay",()->{
   MainActivity c=new MainActivity();sync(c,1,0,Prefs.today(c),"pending",1);
   GateService s=new GateService();event(s,"example.game");
   sync(c,1,1,Prefs.today(c),"done",0);event(s,c.getPackageName());
   check(android.view.WindowManager.removes==1,"completion clears overlay");
   sync(c,1,0,Prefs.today(c),"pending",1);s=new GateService();event(s,"example.game");
   sync(c,0,0,Prefs.today(c),"pending",1);event(s,"com.android.systemui");
   check(android.view.WindowManager.removes==2,"voluntary disable clears overlay");
  });
  test("reject stale future malformed and null day evidence at entry",()->{
   MainActivity c=new MainActivity();
   for(String bad:new String[]{"2000-01-01","2999-01-01","bad",null}){
    sync(c,1,1,bad,"stale",0);
    check(!Prefs.dailyMet(c)&&Prefs.isArmed(c),"invalid completion cannot release gate");
    check(Prefs.gateCanSkip(c)&&!Prefs.gateSummary(c).contains("stale"),"invalid UI evidence ignored");
   }
   TimeZone.setDefault(TimeZone.getTimeZone("GMT-12:00"));
   TimeZone.setDefault(TimeZone.getTimeZone("GMT+14:00"));
   String future=Prefs.today(c);TimeZone.setDefault(TimeZone.getTimeZone("GMT-12:00"));
   sync(c,1,1,future,"future",0);TimeZone.setDefault(TimeZone.getTimeZone("GMT+14:00"));
   check(!Prefs.dailyMet(c),"rejected future record must not become valid later");
  });
  test("stale callback preserves newer valid day evidence",()->{
   MainActivity c=new MainActivity();sync(c,1,1,Prefs.today(c),"current",0);
   sync(c,1,0,"2000-01-01","stale",1);
   check(Prefs.dailyMet(c)&&!Prefs.gateCanSkip(c)&&Prefs.gateSummary(c).equals("current"),"stale payload must not overwrite today's facts");
  });
  test("native filters and disabled reminder stay intact",()->{
   MainActivity c=new MainActivity();sync(c,1,0,Prefs.today(c),"today",1);
   GateService s=new GateService();event(s,c.getPackageName());event(s,"com.android.systemui");event(s,"other.app");
   s.onAccessibilityEvent(null);s.onAccessibilityEvent(new AccessibilityEvent("example.game",1));
   check(AccessibilityService.homes==0,"non-targets ignored");
   Prefs.setReminder(c,false,20,0);new ReminderReceiver().onReceive(c,new Intent());
   check(NotificationManager.sent==0&&AlarmManager.scheduled==0,"disabled reminders remain off");
   check(!Prefs.deepBlock(c)&&!Prefs.gateWatch(c),"root/watch defaults unchanged");
  });
  test("state sync and legacy migration preserve unrelated user settings",()->{
   MainActivity c=new MainActivity();Prefs.setDeepBlock(c,true);Prefs.setGateWatch(c,true);
   Prefs.setReminder(c,false,9,15);Prefs.setMusic(c,"user:music","user song");
   Context.storage.edit().putBoolean("armed",true).apply();
   sync(c,0,0,Prefs.today(c),"pending",1);
   check(!Prefs.isArmed(c),"explicit disable overrides old armed=true");
   c.new Bridge().setGate(1,PACKAGES,"pending",1);
   c.new Bridge().setGate(0,PACKAGES,"unknown",1);
   check(!Prefs.isArmed(c)&&!Prefs.dailyMet(c),"legacy disable remains off without inventing completion");
   check(Prefs.deepBlock(c)&&Prefs.gateWatch(c),"preserve opt-in root/watch values");
   check(!Prefs.reminderEnabled(c)&&Prefs.reminderHour(c)==9&&Prefs.reminderMinute(c)==15,"preserve reminder preferences");
   check(Prefs.musicUri(c).equals("user:music"),"preserve music selection");
  });
  System.out.println("Native checks: "+passed+" passed, "+failed+" failed");
  if(failed>0)System.exit(1);
 }
}
'''


def bridge_methods():
    source = (SRC / "MainActivity.java").read_text(encoding="utf-8")
    methods = []
    for name in ("setGate", "setTrainingState"):
        match = re.search(r"@JavascriptInterface\s+public void " + name + r"\s*\([^)]*\)\s*\{", source)
        if not match:
            continue  # Missing interface is a runtime assertion, not a compile error.
        end, depth = match.end(), 1
        while depth:
            char = source[end]
            depth += (char == "{") - (char == "}")
            end += 1
        methods.append(source[match.start():end])
    return "\n".join(methods)


def main():
    start = time.monotonic()
    javac = shutil.which("javac")
    if not javac:
        base = Path(os.environ.get("JAVA_HOME", "E:/android-build/jdk"))
        javac = str(base / "bin" / ("javac.exe" if os.name == "nt" else "javac"))
    java = str(Path(javac).with_name("java.exe" if os.name == "nt" else "java"))
    if not Path(javac).is_file():
        raise SystemExit("JDK required: set JAVA_HOME or put javac on PATH")
    with tempfile.TemporaryDirectory(prefix="eq-native-gate-") as tmp:
        folder = Path(tmp)
        sources = dict(STUBS)
        for name in ("Prefs", "GateService", "ReminderReceiver"):
            sources[f"com/local/cognitiontrainer/{name}.java"] = (SRC / f"{name}.java").read_text(encoding="utf-8")
        sources["com/local/cognitiontrainer/MainActivity.java"] = (
            "package com.local.cognitiontrainer; import android.webkit.JavascriptInterface; "
            "public class MainActivity extends android.content.Context { "
            'public static final String EXTRA_GATE="gate"; public class Bridge { '
            + bridge_methods() + " } }")
        sources["com/local/cognitiontrainer/NativeGateCheck.java"] = HARNESS
        for rel, code in sources.items():
            dest = folder / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(code, encoding="utf-8")
        subprocess.run([javac, "-encoding", "UTF-8", "--release", "11", "-d", str(folder / "classes"),
                        *[str(folder / name) for name in sources]], check=True, timeout=60)
        result = subprocess.run([java, "-cp", str(folder / "classes"), "com.local.cognitiontrainer.NativeGateCheck"],
                                timeout=30)
    print(f"Elapsed: {time.monotonic() - start:.2f}s", flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
