"use strict";

var QWebChannelMessageTypes = {
    signal: 1,
    propertyUpdate: 2,
    init: 3,
    idle: 4,
    debug: 5,
    invokeMethod: 6,
    connectToSignal: 7,
    disconnectFromSignal: 8,
    setProperty: 9,
    response: 10,
};

var QWebChannel = function (transport, initCallback) {
    if (typeof transport !== "object" || typeof transport.send !== "function") {
        console.error("The QWebChannel expects a transport object with a send function and onmessage callback property." +
            " Given is: transport: " + typeof (transport) + ", transport.send: " + typeof (transport.send));
        return;
    }

    var channel = this;
    this.transport = transport;

    this.send = function (data) {
        if (typeof (data) !== "string") {
            data = JSON.stringify(data);
        }
        channel.transport.send(data);
    }

    this.transport.onmessage = function (message) {
        var data = message.data;
        if (typeof data === "string") {
            data = JSON.parse(data);
        }
        switch (data.type) {
            case QWebChannelMessageTypes.signal:
                channel.handleSignal(data);
                break;
            case QWebChannelMessageTypes.response:
                channel.handleResponse(data);
                break;
            case QWebChannelMessageTypes.propertyUpdate:
                channel.handlePropertyUpdate(data);
                break;
            default:
                console.error("invalid message received:", message.data);
                break;
        }
    }

    this.execCallbacks = {};
    this.execId = 0;
    this.objects = {};

    this.handleSignal = function (message) {
        var object = channel.objects[message.object];
        if (object) {
            object.signalEmitted(message.signal, message.args);
        } else {
            console.warn("Unhandled signal: " + message.object + "::" + message.signal);
        }
    }

    this.handleResponse = function (message) {
        if (!message.hasOwnProperty("id")) {
            console.error("Invalid response message received: ", message);
            return;
        }
        channel.execCallbacks[message.id](message.data);
        delete channel.execCallbacks[message.id];
    }

    this.handlePropertyUpdate = function (message) {
        for (var i in message.data) {
            var data = message.data[i];
            var object = channel.objects[data.object];
            if (object) {
                object.propertyUpdate(data.signals, data.properties);
            } else {
                console.warn("Unhandled property update: " + data.object + "::" + data.signal);
            }
        }
        channel.execCallbacks[message.id](message.data);
        delete channel.execCallbacks[message.id];
    }

    this.debug = function (message) {
        channel.send({ type: QWebChannelMessageTypes.debug, data: message });
    };

    channel.exec = function (data, callback) {
        if (!callback) {
            callback = function () { };
        }
        if (channel.execId === Number.MAX_VALUE) {
            channel.execId = Number.MIN_VALUE;
        }
        if (data.hasOwnProperty("id")) {
            console.error("Cannot execute message with property id: " + JSON.stringify(data));
            return;
        }
        data.id = channel.execId++;
        channel.execCallbacks[data.id] = callback;
        channel.send(data);
    };

    channel.exec({ type: QWebChannelMessageTypes.init }, function (data) {
        for (var objectName in data) {
            var object = new QObject(objectName, data[objectName], channel);
        }
        for (var objectName in channel.objects) {
            channel.objects[objectName].unwrapProperties();
        }
        if (initCallback) {
            initCallback(channel);
        }
        channel.exec({ type: QWebChannelMessageTypes.idle });
    });
};

function QObject(name, data, webChannel) {
    this.__id__ = name;
    webChannel.objects[name] = this;

    // List of callbacks that get invoked upon signal emission
    this.__objectSignals__ = {};

    // Cache of all properties, updated when a notify signal is emitted
    this.__propertyCache__ = {};

    var object = this;

    // ----------------------------------------------------------------------
    // Property binding
    // ----------------------------------------------------------------------

    this.unwrapProperties = function () {
        for (var propertyIndex in data.properties) {
            object.unwrapProperty(propertyIndex, data.properties[propertyIndex]);
        }
    }

    this.unwrapProperty = function (propertyIndex, value) {
        Object.defineProperty(object, propertyIndex, {
            get: function () {
                var propertyValue = object.__propertyCache__[propertyIndex];
                if (propertyValue === undefined) {
                    // This re-enables the property cache for the given property
                    // if it was disabled by a property update.
                    // This is done to avoid sending unneeded property updates
                    // from the C++ side.
                    // See also QWebChannelAbstractTransport::notifyPropertyUpdate
                    // for the other side of this.
                    // object.__propertyCache__[propertyIndex] = value;
                }
                return value;
            },
            set: function (newValue) {
                value = newValue;
                webChannel.exec({
                    type: QWebChannelMessageTypes.setProperty,
                    object: object.__id__,
                    property: propertyIndex,
                    value: newValue
                });
            },
            configurable: true
        });
        object.__propertyCache__[propertyIndex] = value;
    }

    this.propertyUpdate = function (signals, properties) {
        for (var propertyIndex in properties) {
            var value = properties[propertyIndex];
            object.__propertyCache__[propertyIndex] = value;
        }

        for (var signalName in signals) {
            var object = this;
            object.signalEmitted(signalName, signals[signalName]);
        }
    }

    // ----------------------------------------------------------------------
    // Signal binding
    // ----------------------------------------------------------------------

    this.signalEmitted = function (signalName, signalArgs) {
        var handlers = object.__objectSignals__[signalName];
        if (handlers) {
            handlers.forEach(function (handler) {
                handler.apply(object, signalArgs);
            });
        }
    }

    this.connect = function (signalName, handler) {
        if (typeof handler !== "function") {
            console.error("connectToSignal: expects a callback function. Given: " + typeof handler);
            return;
        }

        if (!object.__objectSignals__[signalName]) {
            object.__objectSignals__[signalName] = [];
            webChannel.exec({
                type: QWebChannelMessageTypes.connectToSignal,
                object: object.__id__,
                signal: signalName
            });
        }
        object.__objectSignals__[signalName].push(handler);
    }

    this.disconnect = function (signalName, handler) {
        var handlers = object.__objectSignals__[signalName];
        if (handlers) {
            var index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
                if (handlers.length === 0) {
                    delete object.__objectSignals__[signalName];
                    webChannel.exec({
                        type: QWebChannelMessageTypes.disconnectFromSignal,
                        object: object.__id__,
                        signal: signalName
                    });
                }
            }
        }
    }

    // ----------------------------------------------------------------------
    // Method binding
    // ----------------------------------------------------------------------

    this.unwrapMethods = function () {
        for (var methodIndex in data.methods) {
            object.unwrapMethod(data.methods[methodIndex]);
        }
    }

    this.unwrapMethod = function (methodName) {
        object[methodName] = function () {
            var args = [];
            var callback;
            for (var i = 0; i < arguments.length; i++) {
                if (typeof arguments[i] === "function") {
                    callback = arguments[i];
                } else {
                    args.push(arguments[i]);
                }
            }
            webChannel.exec({
                "type": QWebChannelMessageTypes.invokeMethod,
                "object": object.__id__,
                "method": methodName,
                "args": args
            }, function (response) {
                if (response !== undefined) {
                    if (callback) {
                        callback(response);
                    }
                }
            });
        };
    }

    this.unwrapMethods();
}
