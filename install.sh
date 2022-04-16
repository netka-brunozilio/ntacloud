#!/usr/bin/env bash

[ ! -n "$BASH_VERSION" ] && echo "You can only run this script with bash, not sh / dash." && exit 1

set -eou pipefail
VERSION="v0.1.0"

ARCH=$(uname -m)

WHO=$(whoami)

NTACLOUD_APP_ID=$(cat /proc/sys/kernel/random/uuid)
NTACLOUD_SECRET_KEY=$(echo $(($(date +%s%N) / 1000000)) | sha256sum | base64 | head -c 32)
NTACLOUD_SENTRY_DSN=""
NTACLOUD_WHITE_LABELED=true

DOCKER_MAJOR=20
DOCKER_MINOR=10
DOCKER_VERSION_OK="nok"

FORCE=0

NTACLOUD_CONF_FOUND=$(find ~ -path '*/ntacloud/.env')
if [ -n "$NTACLOUD_CONF_FOUND" ]; then
    eval "$(grep ^NTACLOUD_APP_ID= $NTACLOUD_CONF_FOUND)"
    eval "$(grep ^NTACLOUD_SECRET_KEY= $NTACLOUD_CONF_FOUND)"
    eval "$(grep ^NTACLOUD_DATABASE_URL= $NTACLOUD_CONF_FOUND)"
    eval "$(grep ^NTACLOUD_SENTRY_DSN= $NTACLOUD_CONF_FOUND)"
    eval "$(grep ^NTACLOUD_HOSTED_ON= $NTACLOUD_CONF_FOUND)"
else
    NTACLOUD_CONF_FOUND=${NTACLOUD_CONF_FOUND:="$HOME/ntacloud/.env"}
fi

# Making base directory for ntacloud
if [ ! -d ~/ntacloud ]; then
    mkdir ~/ntacloud
fi

function doNotTrack() {
      DO_NOT_TRACK=1
      NTACLOUD_SENTRY_DSN=
      NTACLOUD_APP_ID=
}

if [ -z ${DO_NOT_TRACK+0} ]; then
    DO_NOT_TRACK=0
else 
    if [ ${DO_NOT_TRACK} -eq 1 ]; then
        doNotTrack
    fi
fi

POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
    echo -e "NTACloud installer $VERSION
  Usage: install.sh [options...] 
    -d, --debug         Show debug logs during installation.
    -f, --force         Force installation, no questions asked.
    --do-not-track      Opt-out of telemetry. You can set export DO_NOT_TRACK=1 in advance.
    ".
    exit 1
    ;;
    -d|--debug)
      set -x
      shift
      ;;
    -f|--force)
      FORCE=1
      shift
      ;;
    --do-not-track)
      doNotTrack
      shift
      ;;
    --white-labeled)
      NTACLOUD_WHITE_LABELED="true"
      shift
      ;;
    -*|--*)
      echo "Unknown option $1"
      exit 1
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL_ARGS[@]}"

function errorchecker() {
    exitCode=$?
    if [ $exitCode -ne "0" ]; then
        echo "$0 exited unexpectedly with status: $exitCode"
        exit $exitCode
    fi
}
trap 'errorchecker' EXIT
if [ $FORCE -eq 1 ]; then
    echo "Installing NTACloud with force option."
fi

# Check if user is root
if [ $WHO != 'root' ]; then
    echo 'Run as root please: sudo bash ./install.sh'
    exit 1
fi

function restartDocker() {
   # Restarting docker daemon
   sudo systemctl daemon-reload
   sudo systemctl restart docker
}

function dockerConfiguration() {
    cat <<EOF >/etc/docker/daemon.json
{
    "log-driver": "json-file",
    "log-opts": {
      "max-size": "100m",
      "max-file": "5"
    },
    "features": {
        "buildkit": true
    },
    "live-restore": true,
    "default-address-pools" : [
    {
      "base" : "172.17.0.0/12",
      "size" : 20
    },
    {
      "base" : "192.168.0.0/16",
      "size" : 24
    }
  ]
}
EOF
}
function saveNTACloudConfiguration() {
      echo "NTACLOUD_APP_ID=$NTACLOUD_APP_ID
NTACLOUD_SECRET_KEY=$NTACLOUD_SECRET_KEY
NTACLOUD_DATABASE_URL=file:../db/prod.db
NTACLOUD_SENTRY_DSN=$NTACLOUD_SENTRY_DSN
NTACLOUD_HOSTED_ON=docker
NTACLOUD_WHITE_LABELED=$NTACLOUD_WHITE_LABELED" > $NTACLOUD_CONF_FOUND
}
# Check docker version
if [ ! -x "$(command -v docker)" ]; then
    if [ $FORCE -eq 1 ]; then
        sh -c "$(curl --silent -fsSL https://get.docker.com)"
        restartDocker
    else
        while true; do
            read -p "Docker Engine not found, should I install it automatically? [Yy/Nn] " yn
            case $yn in
            [Yy]*)
                echo "Installing Docker."
                sh -c "$(curl --silent -fsSL https://get.docker.com)"
                restartDocker
                break
                ;;
            [Nn]*)
                echo "Please install docker manually and update it to the latest, but at least to $DOCKER_MAJOR.$DOCKER_MINOR"
                exit 0
                ;;
            *) echo "Please answer Y or N." ;;
            esac
        done
    fi
fi

# Check docker swarm
if [ "$(sudo docker info --format '{{.Swarm.ControlAvailable}}')" = "true" ]; then
    echo "NTACloud does not support Docker Swarm yet. Please use a non-swarm compatible version of Docker."
    exit 1
fi

SERVER_VERSION=$(sudo docker version -f "{{.Server.Version}}")
SERVER_VERSION_MAJOR=$(echo "$SERVER_VERSION" | cut -d'.' -f 1)
SERVER_VERSION_MINOR=$(echo "$SERVER_VERSION" | cut -d'.' -f 2)

if [ "$SERVER_VERSION_MAJOR" -ge "$DOCKER_MAJOR" ] &&
    [ "$SERVER_VERSION_MINOR" -ge "$DOCKER_MINOR" ]; then
    DOCKER_VERSION_OK="ok"
fi

if [ $DOCKER_VERSION_OK == 'nok' ]; then
    echo "Docker version less than $DOCKER_MAJOR.$DOCKER_MINOR, please update it to at least to $DOCKER_MAJOR.$DOCKER_MINOR"
    exit 1
fi

if [ -f "/etc/docker/daemon.json" ]; then
    if [ $FORCE -eq 1 ]; then
        # Adding docker daemon configuration
        echo 'Configuring Docker daemon.'
        dockerConfiguration
    else
      while true; do
            read -p "Docker already configured. I will overwrite it, okay? [Yy/Nn] " yn
            case $yn in
            [Yy]*)
                dockerConfiguration
                restartDocker
                break
                ;;
            [Nn]*)
                echo "Cannot continue."
                exit 1
                ;;
            *) echo "Please answer Y or N." ;;
            esac
        done
    fi
else
    # Adding docker daemon configuration
    cat <<EOF >/etc/docker/daemon.json
{
    "log-driver": "json-file",
    "log-opts": {
      "max-size": "100m",
      "max-file": "5"
    },
    "features": {
        "buildkit": true
    },
    "live-restore": true,
    "default-address-pools" : [
    {
      "base" : "172.17.0.0/12",
      "size" : 20
    },
    {
      "base" : "192.168.0.0/16",
      "size" : 24
    }
  ]
}
EOF
fi

restartDocker

if [ $FORCE -eq 1 ]; then
    echo 'Updating NTACloud configuration.'
    saveNTACloudConfiguration
else
    if [ -f "$NTACLOUD_CONF_FOUND" ]; then
        while true; do
                    read -p "NTACloud configuration found (${NTACLOUD_CONF_FOUND}). I will overwrite it, okay? [Yy/Nn] " yn
                    case $yn in
                    [Yy]*)
                        saveNTACloudConfiguration
                        break
                        ;;
                    [Nn]*)
                        break
                        ;;
                    *) echo "Please answer Y or N." ;;
                    esac
                done
        else
            saveNTACloudConfiguration
    fi
fi
if [ $FORCE -ne 1 ]; then
    echo "Installing NTACloud."
fi
sudo docker pull -q netka/ntacloud:latest > /dev/null
cd ~/ntacloud && sudo docker run -tid --env-file $NTACLOUD_CONF_FOUND -v /var/run/docker.sock:/var/run/docker.sock -v ntacloud-db-sqlite netka/ntacloud:latest /bin/sh -c "env | grep NTACLOUD > .env && docker compose up -d --force-recreate" > /dev/null

echo -e "\nCongratulations! Your NTACloud instance is ready to use."
echo "Please visit http://$(curl -4s https://ifconfig.io):3000 to get started."
echo "It will take a few minutes to start up, don't worry."