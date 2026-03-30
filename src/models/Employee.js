module.exports = (sequelize, DataTypes) => {
  function splitFullName(value) {
    const safeValue = String(value || '').trim();

    if (!safeValue) {
      return {
        firstName: '',
        lastName: '',
      };
    }

    const parts = safeValue.split(/\s+/);
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  const Employee = sequelize.define(
    'Employee',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branch_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      department_id: DataTypes.UUID,
      shift_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      first_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      last_name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      emp_code: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      name: {
        type: DataTypes.VIRTUAL,
        get() {
          const firstName = this.getDataValue('first_name') || '';
          const lastName = this.getDataValue('last_name') || '';
          return `${firstName} ${lastName}`.trim();
        },
        set(value) {
          const { firstName, lastName } = splitFullName(value);
          this.setDataValue('first_name', firstName);
          this.setDataValue('last_name', lastName);
        },
      },
      email: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      phone: DataTypes.STRING,
      password_hash: DataTypes.STRING,
      role: {
        type: DataTypes.ENUM('admin', 'manager', 'employee', 'superadmin'),
        defaultValue: 'employee',
      },
      face_embedding_local: {
        type: DataTypes.JSONB,
        defaultValue: null,
      },
      face_embedding_id: DataTypes.STRING,
      face_enrolled_at: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      registered_device_id: DataTypes.STRING,
      trust_score: {
        type: DataTypes.VIRTUAL,
        get() {
          return 'probationary';
        },
      },
      checkin_count: {
        type: DataTypes.VIRTUAL,
        get() {
          return 0;
        },
      },
      leave_balance: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      temp_password: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      password_changed: {
        type: DataTypes.VIRTUAL,
        get() {
          return true;
        },
      },
    },
    {
      tableName: 'employees',
      paranoid: true,
      underscored: true,
    }
  );

  Employee.associate = (models) => {
    Employee.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Employee.belongsTo(models.Branch, {
      foreignKey: 'branch_id',
      as: 'branch',
    });
    Employee.belongsTo(models.Department, {
      foreignKey: 'department_id',
      as: 'department',
    });
    Employee.belongsTo(models.Shift, {
      foreignKey: 'shift_id',
      as: 'shift',
    });
    Employee.hasMany(models.RefreshToken, {
      foreignKey: 'emp_id',
      as: 'refreshTokens',
    });
    Employee.hasMany(models.Attendance, {
      foreignKey: 'emp_id',
      as: 'attendances',
    });
  };

  return Employee;
};
