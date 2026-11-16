package com.fran57444.amgc;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AMGCMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
