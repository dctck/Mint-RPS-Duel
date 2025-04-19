FROM rust:1.74-slim

# Install required packages for building Rust projects
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    pkg-config \
    libssl-dev \
    libclang-dev \
    cmake \
    clang \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Clone Wallet Daemon repo
RUN git clone https://github.com/enjin/wallet-daemon .

# Build it
RUN cargo build --release

# Expose port used by Wallet Daemon
EXPOSE 8282

# Run the binary
CMD ["./target/release/enjin-wallet-daemon"]
